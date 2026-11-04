// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {VigilReserve} from "../src/VigilReserve.sol";
import {IERC20Min, IBorrowerOperationsSignatures, ITroveManager} from "../src/interfaces/IMezo.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MezoTestnet, IBorrowerOperationsTest, ITroveManagerTest} from "./MezoTestnet.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Runs against a fork of Mezo testnet, so every rescue goes through the real MUSD contracts.
/// Only the oracle is replaced, because Mezo's oracle does not work on a local fork.
contract VigilReserveForkTest is Test {
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant REPAY_MUSD_TYPEHASH =
        keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)");

    uint256 constant PRICE = 80_000e18;
    uint256 constant DEBT = 40_000e18;
    uint256 constant TRIGGER = 1.5e18; // 150%
    uint256 constant RESERVE = 10_000e18;
    uint256 constant RESCUE = 5_000e18;

    VigilReserve vigil;
    MockAggregator oracle;
    IERC20Min musd = IERC20Min(MezoTestnet.MUSD);
    ITroveManager troveManager = ITroveManager(MezoTestnet.TROVE_MANAGER);
    IBorrowerOperationsSignatures sigOps = IBorrowerOperationsSignatures(MezoTestnet.BORROWER_OPERATIONS_SIGNATURES);

    uint256 borrowerKey = 0xB0B;
    address borrower;
    address keeper = makeAddr("keeper");

    event Rescued(
        address indexed borrower,
        address indexed keeper,
        uint256 amount,
        uint256 price,
        uint256 icrBefore,
        uint256 icrAfter,
        uint8 reason,
        uint256 debtAhead
    );

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC", string("https://rpc.test.mezo.org")));

        vm.etch(MezoTestnet.ORACLE, type(MockAggregator).runtimeCode);
        oracle = MockAggregator(MezoTestnet.ORACLE);
        oracle.set(int256(PRICE));

        vigil = new VigilReserve(
            MezoTestnet.MUSD,
            MezoTestnet.PRICE_FEED,
            MezoTestnet.TROVE_MANAGER,
            MezoTestnet.BORROWER_OPERATIONS_SIGNATURES
        );

        // A fresh borrower: 1 BTC collateral, 40,000 MUSD debt (~200% ICR at $80k).
        borrower = vm.addr(borrowerKey);
        vm.deal(borrower, 1 ether);
        vm.startPrank(borrower);
        IBorrowerOperationsTest(MezoTestnet.BORROWER_OPERATIONS).openTrove{value: 1 ether}(DEBT, address(0), address(0));
        IERC20Approve(MezoTestnet.MUSD).approve(address(vigil), RESERVE);
        vigil.deposit(borrower, RESERVE);
        vigil.setTrigger(TRIGGER);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _sign(uint256 amount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                MezoTestnet.BORROWER_OPERATIONS_SIGNATURES
            )
        );
        bytes32 structHash = keccak256(abi.encode(REPAY_MUSD_TYPEHASH, amount, borrower, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(borrowerKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _signNow(uint256 amount) internal view returns (bytes memory sig, uint256 deadline) {
        deadline = block.timestamp + 7 days;
        sig = _sign(amount, sigOps.getNonce(borrower), deadline);
    }

    function _debt() internal view returns (uint256) {
        (, uint256 principal, uint256 interest,,,) =
            ITroveManagerTest(MezoTestnet.TROVE_MANAGER).getEntireDebtAndColl(borrower);
        return principal + interest;
    }

    function _icr() internal view returns (uint256) {
        return troveManager.getCurrentICR(borrower, uint256(oracle.price()));
    }

    /// $55k puts the trove at ~137%, under the 150% trigger.
    function _crash() internal {
        oracle.set(int256(55_000e18));
    }

    // ------------------------------------------------------------------ allowed rescue

    function test_RescueBelowTrigger_RepaysFromReserve() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        _crash();
        uint256 icrBefore = _icr();
        uint256 debtBefore = _debt();
        assertLt(icrBefore, TRIGGER);

        vm.expectEmit(true, true, false, false, address(vigil));
        emit Rescued(borrower, keeper, RESCUE, 0, 0, 0, 0, 0);
        vm.prank(keeper);
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));

        assertEq(vigil.reserveOf(borrower), RESERVE - RESCUE, "reserve spent");
        assertEq(musd.balanceOf(address(vigil)), RESERVE - RESCUE, "MUSD burned from reserve");
        assertApproxEqAbs(_debt(), debtBefore - RESCUE, 1e18, "debt reduced by the signed amount");
        assertGt(_icr(), icrBefore, "ICR improved");
        assertEq(sigOps.getNonce(borrower), 1, "nonce consumed");
    }

    function test_CanRescueView() public {
        (bool ok,,) = vigil.canRescue(borrower, RESCUE);
        assertFalse(ok, "healthy trove");
        _crash();
        (ok,,) = vigil.canRescue(borrower, RESCUE);
        assertTrue(ok, "below trigger");
        (ok,,) = vigil.canRescue(borrower, RESERVE + 1);
        assertFalse(ok, "reserve too small");
    }

    // ------------------------------------------------------------------ rejected rescues

    function test_Reject_AboveTrigger() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        uint256 icr = _icr();
        vm.expectRevert(abi.encodeWithSelector(VigilReserve.AboveTrigger.selector, icr, TRIGGER));
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_StaleOracle() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        _crash();
        oracle.setStaleBy(61);
        vm.expectRevert(bytes("PriceFeed: Oracle is stale."));
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_TamperedAmount() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        _crash();
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        vigil.rescue(borrower, RESCUE + 1_000e18, deadline, sig, address(0), address(0));
    }

    function test_Reject_ExpiredSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(RESCUE, sigOps.getNonce(borrower), deadline);
        _crash();
        vm.warp(deadline + 1);
        vm.expectRevert(bytes("Signature expired"));
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_NonceMovedVoidsRescue() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        // The borrower signs and submits a different action first, which consumes the nonce.
        (bytes memory other, uint256 otherDeadline) = _signNow(100e18);
        vm.prank(borrower);
        sigOps.repayMUSDWithSignature(100e18, address(0), address(0), borrower, other, otherDeadline);

        _crash();
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_ReserveTooSmall() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESERVE + 1);
        _crash();
        vm.expectRevert(abi.encodeWithSelector(VigilReserve.ReserveTooSmall.selector, RESERVE, RESERVE + 1));
        vigil.rescue(borrower, RESERVE + 1, deadline, sig, address(0), address(0));
    }

    function test_Reject_RescueOff() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        vm.prank(borrower);
        vigil.setTrigger(0);
        _crash();
        vm.expectRevert(VigilReserve.RescueOff.selector);
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_ReplayAfterRescue() public {
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        _crash();
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
        // Push the trove back under the trigger; the same signature must not work twice.
        oracle.set(int256(45_000e18));
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    // ------------------------------------------------------------------ reserve management

    function test_WithdrawOwnReserveOnly() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VigilReserve.ReserveTooSmall.selector, 0, 1));
        vigil.withdraw(1, stranger);

        vm.prank(borrower);
        vigil.withdraw(RESERVE, borrower);
        assertEq(vigil.reserveOf(borrower), 0);
        assertEq(musd.balanceOf(address(vigil)), 0);
    }

    // ------------------------------------------------------------------ redemption guard

    /// Puts the test borrower near the front of Mezo's real redemption queue, with one more fresh
    /// trove ("front") just ahead of it: borrower ~115% ICR, front ~114%, both above 110%.
    function _nearFront() internal returns (address front, uint256 frontDebt) {
        front = makeAddr("front");
        vm.deal(front, 1 ether);
        vm.prank(front);
        IBorrowerOperationsTest(MezoTestnet.BORROWER_OPERATIONS).openTrove{value: 1 ether}(
            69_800e18, address(0), address(0)
        );
        vm.prank(borrower);
        IBorrowerOperationsTest(MezoTestnet.BORROWER_OPERATIONS).withdrawMUSD(29_000e18, address(0), address(0));
        (, uint256 p, uint256 i,,,) = ITroveManagerTest(MezoTestnet.TROVE_MANAGER).getEntireDebtAndColl(front);
        frontDebt = p + i;
        assertGt(troveManager.getCurrentICR(front, PRICE), 1.1e18, "front trove is redeemable");
        assertLt(troveManager.getCurrentICR(front, PRICE), _icr(), "front trove is ahead of the borrower");
    }

    function test_RedemptionGuard_RescuesNearFrontOfQueue() public {
        (, uint256 frontDebt) = _nearFront();
        (bool found, uint256 ahead) = vigil.debtAhead(borrower);
        assertTrue(found, "trove reached within the walk");
        assertGe(ahead, frontDebt, "front trove counted ahead");

        // Ratio trigger off; only the redemption guard can fire.
        vm.startPrank(borrower);
        vigil.setTrigger(0);
        vigil.setRedemptionGuard(ahead + 1);
        vm.stopPrank();
        (bool ok,,) = vigil.canRescue(borrower, RESCUE);
        assertTrue(ok, "guard holds");

        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        uint256 debtBefore = _debt();
        vm.expectEmit(true, true, false, false, address(vigil));
        emit Rescued(borrower, keeper, RESCUE, 0, 0, 0, 0, 0);
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
        emit log_named_uint("rescue gas with queue walk", gasBefore - gasleft());

        assertApproxEqAbs(_debt(), debtBefore - RESCUE, 1e18, "debt reduced by the signed amount");
        assertEq(vigil.reserveOf(borrower), RESERVE - RESCUE, "reserve spent");
    }

    function test_RedemptionGuard_RescueReportsReason() public {
        _nearFront();
        (, uint256 ahead) = vigil.debtAhead(borrower);
        vm.startPrank(borrower);
        vigil.setTrigger(0);
        vigil.setRedemptionGuard(ahead + 1);
        vm.stopPrank();
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        vm.recordLogs();
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
        bytes32 topic = keccak256("Rescued(address,address,uint256,uint256,uint256,uint256,uint8,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(vigil) || logs[i].topics[0] != topic) continue;
            (,,,, uint8 reason, uint256 loggedAhead) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint8, uint256));
            assertEq(reason, vigil.REASON_REDEMPTION());
            assertEq(loggedAhead, ahead);
            seen = true;
        }
        assertTrue(seen, "Rescued emitted");
    }

    function test_Reject_RedemptionGuardNotReached() public {
        (, uint256 frontDebt) = _nearFront();
        (, uint256 ahead) = vigil.debtAhead(borrower);
        assertGe(ahead, frontDebt);
        // A guard no larger than the debt already ahead doesn't hold. The walk stops as soon as the
        // running total reaches the guard, so the revert reports found = false and that total.
        uint256 guard = 1e18;
        vm.startPrank(borrower);
        vigil.setTrigger(0);
        vigil.setRedemptionGuard(guard);
        vm.stopPrank();
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        (bool ok,,) = vigil.canRescue(borrower, RESCUE);
        assertFalse(ok);
        vm.expectPartialRevert(VigilReserve.NotTriggered.selector);
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
    }

    function test_Reject_RedemptionGuardSkipsUnderLiquidationLine() public {
        _nearFront();
        vm.startPrank(borrower);
        vigil.setTrigger(0);
        vigil.setRedemptionGuard(type(uint256).max);
        vm.stopPrank();
        // Under 110% the trove is a liquidation case, not a redemption one: the guard never fires.
        oracle.set(int256(70_000e18));
        assertLt(_icr(), 1.1e18);
        (bool ok,,) = vigil.canRescue(borrower, RESCUE);
        assertFalse(ok);
    }

    function test_RatioTriggerStillFiresWithGuardOn() public {
        vm.prank(borrower);
        vigil.setRedemptionGuard(1);
        (bytes memory sig, uint256 deadline) = _signNow(RESCUE);
        _crash();
        vigil.rescue(borrower, RESCUE, deadline, sig, address(0), address(0));
        assertEq(vigil.reserveOf(borrower), RESERVE - RESCUE);
    }

    function test_TriggerMustBeAboveLiquidationLine() public {
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(VigilReserve.TriggerTooLow.selector, 1.1e18));
        vigil.setTrigger(1.1e18);
    }
}
