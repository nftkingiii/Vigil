// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Min, IPriceFeed, ITroveManager, ISortedTroves} from "./interfaces/IMezo.sol";

/// @title RescueRules
/// @notice When a Vigil rescue may run, shared by VigilReserve (EVM wallets) and VigilSafeModule
///         (Mezo Passport Safe accounts), so both enforce exactly the same conditions and fee.
///
/// A rescue may run, at a fresh oracle price, when at least one of the borrower's conditions holds:
///   1. ratio trigger: the trove's ICR is below the trigger the borrower set (liquidation risk);
///   2. redemption guard: less MUSD debt than the borrower's guard sits ahead of the trove in
///      Mezo's redemption queue (redemption risk). Repaying raises the trove's nominal ICR, which
///      moves it back in the queue.
///
/// The queue is read on-chain the way TroveManager.redeemCollateral walks it: from
/// SortedTroves.getLast() through getPrev(), skipping troves under 110%. The walk stops as soon as
/// the guard is reached, and at MAX_QUEUE_STEPS, so its gas is bounded.
///
/// Fee: each executed rescue pays its submitter FEE_BPS of the amount, capped at FEE_CAP. It is a
/// constant, so the borrower knows it up front, and it lets anyone run a keeper.
abstract contract RescueRules {
    IERC20Min public immutable musd;
    IPriceFeed public immutable priceFeed;
    ITroveManager public immutable troveManager;
    ISortedTroves public immutable sortedTroves;

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

    error TriggerTooLow(uint256 trigger);
    error RescueOff();
    error TroveNotActive();
    error AboveTrigger(uint256 icr, uint256 trigger);
    /// Neither condition holds. `found` is false when the trove wasn't reached within the walk.
    error NotTriggered(uint256 icr, uint256 trigger, bool found, uint256 debtAhead, uint256 guard);

    constructor(address musd_, address priceFeed_, address troveManager_) {
        musd = IERC20Min(musd_);
        priceFeed = IPriceFeed(priceFeed_);
        troveManager = ITroveManager(troveManager_);
        sortedTroves = ISortedTroves(ITroveManager(troveManager_).sortedTroves());
    }

    /// Fee a rescue of `amount` pays its submitter: FEE_BPS of the amount, at most FEE_CAP.
    function feeFor(uint256 amount) public pure returns (uint256) {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        return fee > FEE_CAP ? FEE_CAP : fee;
    }

    /// MUSD of debt ahead of `borrower` in Mezo's redemption queue at the current price, as this
    /// contract sees it. `found` is false if the trove is more than MAX_QUEUE_STEPS troves back.
    function debtAhead(address borrower) external view returns (bool found, uint256 ahead) {
        return _debtAhead(borrower, priceFeed.fetchPrice(), type(uint256).max);
    }

    function _checkTrigger(uint256 triggerICR) internal pure {
        if (triggerICR != 0 && triggerICR <= MIN_TRIGGER_ICR) revert TriggerTooLow(triggerICR);
    }

    /// Fresh price and ICR, then which condition holds. Reverts with the reason when none does.
    function _requireCondition(address borrower, uint256 trigger, uint256 guard)
        internal
        view
        returns (uint256 price, uint256 icr, uint8 reason, uint256 ahead)
    {
        if (trigger == 0 && guard == 0) revert RescueOff();
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) revert TroveNotActive();
        price = priceFeed.fetchPrice(); // reverts on a stale oracle
        icr = troveManager.getCurrentICR(borrower, price);
        bool found;
        (reason, found, ahead) = _condition(borrower, price, icr, trigger, guard);
        if (reason == 0) {
            if (guard == 0) revert AboveTrigger(icr, trigger);
            revert NotTriggered(icr, trigger, found, ahead, guard);
        }
    }

    /// Non-reverting version for views.
    function _conditionHolds(address borrower, uint256 trigger, uint256 guard)
        internal
        view
        returns (bool ok, uint256 icr, uint256 price)
    {
        if (trigger == 0 && guard == 0) return (false, 0, 0);
        if (troveManager.getTroveStatus(borrower) != TROVE_ACTIVE) return (false, 0, 0);
        price = priceFeed.fetchPrice();
        icr = troveManager.getCurrentICR(borrower, price);
        (uint8 reason,,) = _condition(borrower, price, icr, trigger, guard);
        ok = reason != 0;
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
}
