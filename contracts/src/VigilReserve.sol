// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IBorrowerOperationsSignatures} from "./interfaces/IMezo.sol";
import {RescueRules} from "./RescueRules.sol";

/// @title VigilReserve (v4)
/// @notice Holds a borrower's MUSD reserve and spends it on a rescue the borrower pre-signed.
///         For EVM-wallet borrowers; Mezo Passport (Safe) accounts use VigilSafeModule.
///
/// A rescue goes through Mezo's own BorrowerOperationsSignatures.repayMUSDWithSignature, which
/// checks the borrower's EIP-712 signature over (amount, borrower, nonce, deadline) and burns the
/// MUSD from this contract. Vigil therefore cannot change the amount, the borrower or the deadline.
/// When a rescue may run (ratio trigger or redemption guard, at a fresh price) and the fee it pays
/// are in RescueRules. The borrower's own reserve must cover the amount plus the fee.
///
/// Stepped rescues: a borrower may sign several repays with consecutive Mezo nonces (n, n+1, ...).
/// Only the one matching Mezo's current nonce can succeed, so the current nonce tells this
/// contract which step is live, and `stepTriggerOf[borrower][nonce]` gives that step its own
/// trigger (e.g. 135% for the first repay, 125% for the second). Unset steps use triggerOf.
///
/// It has no owner and no keeper allow-list: anyone may submit a rescue, because a rescue can only
/// ever spend the borrower's own reserve to repay the borrower's own debt (plus the fixed fee), and
/// only when one of the borrower's own conditions holds.
contract VigilReserve is RescueRules {
    IBorrowerOperationsSignatures public immutable borrowerOpsSig;

    uint256 public constant VERSION = 4;

    /// MUSD held for each borrower.
    mapping(address => uint256) public reserveOf;
    /// ICR (1e18 = 100%) below which a rescue is allowed. Zero means the ratio trigger is off.
    mapping(address => uint256) public triggerOf;
    /// MUSD of debt ahead in the redemption queue below which a rescue is allowed. Zero means off.
    mapping(address => uint256) public guardOf;
    /// Per-step ratio trigger, keyed by the Mezo nonce the step's signature uses. Zero = use triggerOf.
    mapping(address => mapping(uint256 => uint256)) public stepTriggerOf;

    event Deposited(address indexed borrower, address indexed from, uint256 amount);
    event Withdrawn(address indexed borrower, address indexed to, uint256 amount);
    event TriggerSet(address indexed borrower, uint256 triggerICR);
    event GuardSet(address indexed borrower, uint256 minDebtAhead);
    event StepTriggerSet(address indexed borrower, uint256 indexed nonce, uint256 triggerICR);
    event Rescued(
        address indexed borrower,
        address indexed keeper,
        uint256 amount,
        uint256 price,
        uint256 icrBefore,
        uint256 icrAfter,
        uint8 reason,
        uint256 debtAhead,
        uint256 fee
    );

    error ZeroAmount();
    error ReserveTooSmall(uint256 reserve, uint256 amount);
    error BurnMismatch(uint256 expected, uint256 actual);
    error TransferFailed();

    constructor(address musd_, address priceFeed_, address troveManager_, address borrowerOpsSig_)
        RescueRules(musd_, priceFeed_, troveManager_)
    {
        borrowerOpsSig = IBorrowerOperationsSignatures(borrowerOpsSig_);
    }

    // ------------------------------------------------------------------ borrower actions

    /// Add MUSD to `borrower`'s reserve. Anyone may top up anyone's reserve.
    function deposit(address borrower, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        reserveOf[borrower] += amount;
        if (!musd.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(borrower, msg.sender, amount);
    }

    /// Withdraw from your own reserve at any time.
    function withdraw(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        uint256 reserve = reserveOf[msg.sender];
        if (reserve < amount) revert ReserveTooSmall(reserve, amount);
        reserveOf[msg.sender] = reserve - amount;
        if (!musd.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    /// Set the ICR below which a rescue may run. Pass 0 to switch the ratio trigger off.
    function setTrigger(uint256 triggerICR) external {
        _checkTrigger(triggerICR);
        triggerOf[msg.sender] = triggerICR;
        emit TriggerSet(msg.sender, triggerICR);
    }

    /// Give the rescue signed with Mezo nonce `nonce` its own ratio trigger. Pass 0 to clear it.
    function setStepTrigger(uint256 nonce, uint256 triggerICR) external {
        _checkTrigger(triggerICR);
        stepTriggerOf[msg.sender][nonce] = triggerICR;
        emit StepTriggerSet(msg.sender, nonce, triggerICR);
    }

    /// Allow a rescue when less than `minDebtAhead` MUSD of other debt would be redeemed before
    /// your trove. Pass 0 to switch the redemption guard off.
    function setRedemptionGuard(uint256 minDebtAhead) external {
        guardOf[msg.sender] = minDebtAhead;
        emit GuardSet(msg.sender, minDebtAhead);
    }

    /// The ratio trigger that applies to `borrower`'s next rescue: the live step's, else triggerOf.
    function activeTrigger(address borrower) public view returns (uint256) {
        uint256 step = stepTriggerOf[borrower][borrowerOpsSig.getNonce(borrower)];
        return step != 0 ? step : triggerOf[borrower];
    }

    // ------------------------------------------------------------------ rescue

    /// Spend `amount` of `borrower`'s reserve on the repay they signed.
    /// Reverts if the oracle is stale, neither condition holds, the reserve is short,
    /// or Mezo rejects the signature (wrong amount, expired, or nonce already used).
    function rescue(
        address borrower,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature,
        address upperHint,
        address lowerHint
    ) external {
        (uint256 price, uint256 icrBefore, uint8 reason, uint256 ahead) =
            _requireCondition(borrower, activeTrigger(borrower), guardOf[borrower]);

        // Debit before the external repay.
        uint256 fee = feeFor(amount);
        uint256 reserve = reserveOf[borrower];
        if (reserve < amount + fee) revert ReserveTooSmall(reserve, amount + fee);
        reserveOf[borrower] = reserve - amount - fee;

        uint256 balanceBefore = musd.balanceOf(address(this));
        borrowerOpsSig.repayMUSDWithSignature(amount, upperHint, lowerHint, borrower, signature, deadline);
        uint256 burned = balanceBefore - musd.balanceOf(address(this));
        if (burned != amount) revert BurnMismatch(amount, burned);
        if (fee > 0 && !musd.transfer(msg.sender, fee)) revert TransferFailed();

        emit Rescued(
            borrower,
            msg.sender,
            amount,
            price,
            icrBefore,
            troveManager.getCurrentICR(borrower, price),
            reason,
            ahead,
            fee
        );
    }

    // ------------------------------------------------------------------ views

    /// Whether a rescue for `borrower` of `amount` would pass Vigil's own guards right now.
    /// Mezo's signature checks are not simulated here; keepers should eth_call `rescue` first.
    function canRescue(address borrower, uint256 amount) external view returns (bool ok, uint256 icr, uint256 price) {
        if (reserveOf[borrower] < amount + feeFor(amount)) return (false, 0, 0);
        return _conditionHolds(borrower, activeTrigger(borrower), guardOf[borrower]);
    }
}
