// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    IERC20Min,
    IPriceFeed,
    ITroveManager,
    ISortedTroves,
    IBorrowerOperationsSignatures
} from "./interfaces/IMezo.sol";

/// @title VigilReserve (v3)
/// @notice Holds a borrower's MUSD reserve and spends it on a rescue the borrower pre-signed.
///
/// A rescue goes through Mezo's own BorrowerOperationsSignatures.repayMUSDWithSignature, which
/// checks the borrower's EIP-712 signature over (amount, borrower, nonce, deadline) and burns the
/// MUSD from this contract. Vigil therefore cannot change the amount, the borrower or the deadline.
///
/// This contract adds its own guards on top. A rescue runs only when the borrower's own reserve
/// covers the amount, at a fresh oracle price, and at least one of the borrower's conditions holds:
///   1. ratio trigger: the trove's ICR is below the trigger the borrower set (liquidation risk);
///   2. redemption guard: less MUSD debt than the borrower's guard sits ahead of the trove in
///      Mezo's redemption queue (redemption risk). Repaying raises the trove's nominal ICR, which
///      moves it back in the queue.
///
/// The queue is read on-chain the way TroveManager.redeemCollateral walks it: from
/// SortedTroves.getLast() through getPrev(), skipping troves under 110%. The walk stops as soon as
/// the guard is reached, and at MAX_QUEUE_STEPS, so its gas is bounded.
///
/// Fee: each executed rescue pays its submitter FEE_BPS of the amount, capped at FEE_CAP, from the
/// same reserve. The fee is fixed in this contract (no owner can change it), so the borrower knows
/// it before signing, and it lets anyone run a keeper: whoever submits a valid rescue first earns it.
///
/// It has no owner and no keeper allow-list: anyone may submit a rescue, because a rescue can only
/// ever spend the borrower's own reserve to repay the borrower's own debt (plus the fixed fee), and
/// only when one of the borrower's own conditions holds.
contract VigilReserve {
    IERC20Min public immutable musd;
    IPriceFeed public immutable priceFeed;
    ITroveManager public immutable troveManager;
    ISortedTroves public immutable sortedTroves;
    IBorrowerOperationsSignatures public immutable borrowerOpsSig;

    uint256 public constant VERSION = 3;
    /// Rescue fee: 0.5% of the repaid amount, at most 25 MUSD, paid to the submitter.
    uint256 public constant FEE_BPS = 50;
    uint256 public constant FEE_CAP = 25e18;
    /// Lowest trigger a borrower may set: the 110% liquidation line (Mezo's MCR).
    uint256 public constant MIN_TRIGGER_ICR = 1.1e18;
    /// Most troves the redemption walk reads before giving up (bounded gas).
    uint256 public constant MAX_QUEUE_STEPS = 60;
    uint8 internal constant TROVE_ACTIVE = 1;

    /// Why a rescue ran.
    uint8 public constant REASON_RATIO = 1;
    uint8 public constant REASON_REDEMPTION = 2;

    /// MUSD held for each borrower.
    mapping(address => uint256) public reserveOf;
    /// ICR (1e18 = 100%) below which a rescue is allowed. Zero means the ratio trigger is off.
    mapping(address => uint256) public triggerOf;
    /// MUSD of debt ahead in the redemption queue below which a rescue is allowed. Zero means off.
    mapping(address => uint256) public guardOf;

    event Deposited(address indexed borrower, address indexed from, uint256 amount);
    event Withdrawn(address indexed borrower, address indexed to, uint256 amount);
    event TriggerSet(address indexed borrower, uint256 triggerICR);
    event GuardSet(address indexed borrower, uint256 minDebtAhead);
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
    error TriggerTooLow(uint256 trigger);
    error RescueOff();
    error TroveNotActive();
    error ReserveTooSmall(uint256 reserve, uint256 amount);
    error AboveTrigger(uint256 icr, uint256 trigger);
    /// Neither condition holds. `found` is false when the trove wasn't reached within the walk.
    error NotTriggered(uint256 icr, uint256 trigger, bool found, uint256 debtAhead, uint256 guard);
    error BurnMismatch(uint256 expected, uint256 actual);
    error TransferFailed();

    constructor(address musd_, address priceFeed_, address troveManager_, address borrowerOpsSig_) {
        musd = IERC20Min(musd_);
        priceFeed = IPriceFeed(priceFeed_);
        troveManager = ITroveManager(troveManager_);
        sortedTroves = ISortedTroves(ITroveManager(troveManager_).sortedTroves());
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
        if (triggerICR != 0 && triggerICR <= MIN_TRIGGER_ICR) revert TriggerTooLow(triggerICR);
        triggerOf[msg.sender] = triggerICR;
        emit TriggerSet(msg.sender, triggerICR);
    }

    /// Allow a rescue when less than `minDebtAhead` MUSD of other debt would be redeemed before
    /// your trove. Pass 0 to switch the redemption guard off.
    function setRedemptionGuard(uint256 minDebtAhead) external {
        guardOf[msg.sender] = minDebtAhead;
        emit GuardSet(msg.sender, minDebtAhead);
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
        (uint256 price, uint256 icrBefore, uint8 reason, uint256 ahead, uint256 fee) = _checkAndDebit(borrower, amount);

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

    /// Vigil's guards, then the reserve debit (effects before the external repay).
    function _checkAndDebit(address borrower, uint256 amount)
        internal
        returns (uint256 price, uint256 icr, uint8 reason, uint256 ahead, uint256 fee)
    {
        uint256 trigger = triggerOf[borrower];
        uint256 guard = guardOf[borrower];
        if (trigger == 0 && guard == 0) revert RescueOff();
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) revert TroveNotActive();

        fee = feeFor(amount);
        uint256 reserve = reserveOf[borrower];
        if (reserve < amount + fee) revert ReserveTooSmall(reserve, amount + fee);

        price = priceFeed.fetchPrice(); // reverts on a stale oracle
        icr = troveManager.getCurrentICR(borrower, price);
        bool found;
        (reason, found, ahead) = _condition(borrower, price, icr, trigger, guard);
        if (reason == 0) {
            if (guard == 0) revert AboveTrigger(icr, trigger);
            revert NotTriggered(icr, trigger, found, ahead, guard);
        }

        reserveOf[borrower] = reserve - amount - fee;
    }

    /// Which condition holds, if any: the ratio trigger first (cheap), then the redemption guard.
    function _condition(address borrower, uint256 price, uint256 icr, uint256 trigger, uint256 guard)
        internal
        view
        returns (uint8 reason, bool found, uint256 ahead)
    {
        if (trigger != 0 && icr < trigger) return (REASON_RATIO, false, 0);
        // A trove under 110% isn't redeemable (Mezo skips it); that is liquidation risk, not redemption.
        if (guard == 0 || icr < MIN_TRIGGER_ICR) return (0, false, 0);
        (found, ahead) = _debtAhead(borrower, price, guard);
        if (found && ahead < guard) return (REASON_REDEMPTION, true, ahead);
        return (0, found, ahead);
    }

    /// MUSD debt redeemed before `borrower`, walking the queue as TroveManager.redeemCollateral does.
    /// Stops early once `stopAt` is reached (the guard can't hold), and after MAX_QUEUE_STEPS troves.
    function _debtAhead(address borrower, uint256 price, uint256 stopAt)
        internal
        view
        returns (bool found, uint256 ahead)
    {
        address current = sortedTroves.getLast();
        for (uint256 i = 0; i < MAX_QUEUE_STEPS && current != address(0); i++) {
            if (current == borrower) return (true, ahead);
            if (troveManager.getCurrentICR(current, price) >= MIN_TRIGGER_ICR) {
                (, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(current);
                ahead += principal + interest;
                if (ahead >= stopAt) return (false, ahead);
            }
            current = sortedTroves.getPrev(current);
        }
        return (false, ahead);
    }

    // ------------------------------------------------------------------ views

    /// Fee a rescue of `amount` pays its submitter: FEE_BPS of the amount, at most FEE_CAP.
    function feeFor(uint256 amount) public pure returns (uint256) {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        return fee > FEE_CAP ? FEE_CAP : fee;
    }

    /// Whether a rescue for `borrower` of `amount` would pass Vigil's own guards right now.
    /// Mezo's signature checks are not simulated here; keepers should eth_call `rescue` first.
    function canRescue(address borrower, uint256 amount) external view returns (bool ok, uint256 icr, uint256 price) {
        uint256 trigger = triggerOf[borrower];
        uint256 guard = guardOf[borrower];
        if ((trigger == 0 && guard == 0) || reserveOf[borrower] < amount + feeFor(amount)) return (false, 0, 0);
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) return (false, 0, 0);
        price = priceFeed.fetchPrice();
        icr = troveManager.getCurrentICR(borrower, price);
        (uint8 reason,,) = _condition(borrower, price, icr, trigger, guard);
        ok = reason != 0;
    }

    /// MUSD of debt ahead of `borrower` in Mezo's redemption queue at the current price, as this
    /// contract sees it. `found` is false if the trove is more than MAX_QUEUE_STEPS troves back.
    function debtAhead(address borrower) external view returns (bool found, uint256 ahead) {
        return _debtAhead(borrower, priceFeed.fetchPrice(), type(uint256).max);
    }
}
