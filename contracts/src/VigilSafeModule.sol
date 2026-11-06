// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IBorrowerOperations, IERC20Min, ISafe} from "./interfaces/IMezo.sol";
import {RescueRules} from "./RescueRules.sol";

/// @title VigilSafeModule
/// @notice Vigil rescues for Mezo Passport accounts. A Passport account is a Safe (v1.4.1) owned by
///         a Bitcoin key, so it can't produce the ECDSA signature MUSD's repayMUSDWithSignature
///         checks. Instead the account enables this module once, with one Bitcoin-wallet
///         signature, and the module repays the account's own MUSD debt from the account's own
///         MUSD, as the account, when one of its conditions holds.
///
/// What the module can make the Safe do, and nothing else:
///   - BorrowerOperations.repayMUSD(amount) for the Safe's own trove, with `amount` the Safe chose;
///   - MUSD.transfer(submitter, fee) with the fixed fee from RescueRules.
/// Both are plain calls (never delegatecall) to addresses fixed at deployment. Each rescue needs a
/// condition from RescueRules at a fresh price (ratio trigger or redemption guard), and counts
/// against the number of rescues the Safe allowed. The Safe can change its settings, or remove the
/// module, at any time with a normal signed Safe transaction.
///
/// Stepped rescues: `triggers` lists the ratio trigger for each rescue in turn (the last one
/// repeats), e.g. [135%, 125%] for a first repay at 135% and later ones at 125%.
///
/// No owner, no admin, no keeper allow-list: anyone may submit a rescue and earn the fee.
contract VigilSafeModule is RescueRules {
    IBorrowerOperations public immutable borrowerOperations;

    uint256 public constant VERSION = 1;
    uint8 internal constant CALL = 0;

    struct Config {
        uint256 amount; // MUSD repaid per rescue
        uint256 guard; // redemption guard, MUSD of debt ahead; 0 = off
        uint256 rescuesLeft; // rescues still allowed
        uint256 done; // rescues executed since the last configure
    }

    mapping(address => Config) public configOf;
    mapping(address => uint256[]) internal _triggers;
    bool private _locked;

    event Configured(address indexed safe, uint256 amount, uint256 guard, uint256[] triggers, uint256 maxRescues);
    event SafeRescued(
        address indexed safe,
        address indexed keeper,
        uint256 amount,
        uint256 price,
        uint256 icrBefore,
        uint256 icrAfter,
        uint8 reason,
        uint256 debtAhead,
        uint256 fee
    );

    error ModuleNotEnabled();
    error NoRescuesLeft();
    error ZeroAmount();
    error MusdTooLow(uint256 balance, uint256 needed);
    error SafeCallFailed(bytes returnData);
    error SpendMismatch(uint256 expected, uint256 actual);
    error Reentrant();

    constructor(address musd_, address priceFeed_, address troveManager_, address borrowerOperations_)
        RescueRules(musd_, priceFeed_, troveManager_)
    {
        borrowerOperations = IBorrowerOperations(borrowerOperations_);
    }

    /// Called by the Safe itself (a signed Safe transaction) to set how it wants to be rescued.
    /// `maxRescues` 0 switches rescues off. Calling again resets the step count.
    function configure(uint256 amount, uint256 guard, uint256[] calldata triggers, uint256 maxRescues) external {
        if (maxRescues != 0 && amount == 0) revert ZeroAmount();
        for (uint256 i = 0; i < triggers.length; i++) {
            _checkTrigger(triggers[i]);
        }
        configOf[msg.sender] = Config({amount: amount, guard: guard, rescuesLeft: maxRescues, done: 0});
        _triggers[msg.sender] = triggers;
        emit Configured(msg.sender, amount, guard, triggers, maxRescues);
    }

    function triggersOf(address safe) external view returns (uint256[] memory) {
        return _triggers[safe];
    }

    /// The ratio trigger for the Safe's next rescue: its step's entry, the last one once past the end.
    function activeTrigger(address safe) public view returns (uint256) {
        uint256[] storage t = _triggers[safe];
        if (t.length == 0) return 0;
        uint256 i = configOf[safe].done;
        return t[i < t.length ? i : t.length - 1];
    }

    /// Repay the Safe's configured amount from the Safe's own MUSD, as the Safe.
    function rescue(address safe, address upperHint, address lowerHint) external {
        if (_locked) revert Reentrant();
        _locked = true;

        if (!ISafe(safe).isModuleEnabled(address(this))) revert ModuleNotEnabled();
        Config storage c = configOf[safe];
        if (c.rescuesLeft == 0) revert NoRescuesLeft();
        uint256 amount = c.amount;

        (uint256 price, uint256 icrBefore, uint8 reason, uint256 ahead) =
            _requireCondition(safe, activeTrigger(safe), c.guard);

        uint256 fee = feeFor(amount);
        uint256 before = musd.balanceOf(safe);
        if (before < amount + fee) revert MusdTooLow(before, amount + fee);

        c.rescuesLeft -= 1;
        c.done += 1;

        _exec(safe, address(borrowerOperations), abi.encodeCall(IBorrowerOperations.repayMUSD, (amount, upperHint, lowerHint)));
        if (fee > 0) _exec(safe, address(musd), abi.encodeCall(IERC20Min.transfer, (msg.sender, fee)));

        uint256 spent = before - musd.balanceOf(safe);
        if (spent != amount + fee) revert SpendMismatch(amount + fee, spent);

        emit SafeRescued(
            safe, msg.sender, amount, price, icrBefore, troveManager.getCurrentICR(safe, price), reason, ahead, fee
        );
        _locked = false;
    }

    /// Whether `safe` could be rescued right now: module on, rescues left, MUSD for amount + fee,
    /// and a condition holding at a fresh price.
    function canRescue(address safe) external view returns (bool ok, uint256 icr, uint256 price) {
        Config storage c = configOf[safe];
        if (c.rescuesLeft == 0 || !ISafe(safe).isModuleEnabled(address(this))) return (false, 0, 0);
        if (musd.balanceOf(safe) < c.amount + feeFor(c.amount)) return (false, 0, 0);
        return _conditionHolds(safe, activeTrigger(safe), c.guard);
    }

    function _exec(address safe, address to, bytes memory data) internal {
        (bool ok, bytes memory ret) = ISafe(safe).execTransactionFromModuleReturnData(to, 0, data, CALL);
        if (!ok) revert SafeCallFailed(ret);
        // A token transfer that returns false (rather than reverting) is a failure too.
        if (to == address(musd) && ret.length == 32 && !abi.decode(ret, (bool))) revert SafeCallFailed(ret);
    }
}
