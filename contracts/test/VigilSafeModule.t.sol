// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {VigilSafeModule} from "../src/VigilSafeModule.sol";
import {RescueRules} from "../src/RescueRules.sol";
import {IERC20Min, ITroveManager} from "../src/interfaces/IMezo.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MezoTestnet, ITroveManagerTest} from "./MezoTestnet.sol";

interface ISafeAdmin {
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function isModuleEnabled(address module) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/// Runs on a fork of Mezo testnet against a real Mezo Passport account: a Safe v1.4.1 owned by a
/// BitcoinSafeOwner (OrangeKit). Pranking as the Safe stands in for the owner's Bitcoin-signed Safe
/// transactions (enableModule, configure); everything else is Mezo's real contracts.
contract VigilSafeModuleForkTest is Test {
    address constant PASSPORT_SAFE = 0xf13Aa8136D1f6Fbb0f1adf4bC4bd4f70Ec21edf1;
    address constant SAFE_4337_MODULE = 0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226;
    address constant SENTINEL = address(0x1);
    uint256 constant PRICE = 80_000e18; // ~133% for this account (0.0335 BTC, ~2,018 MUSD debt)
    // The account's debt sits ~18 MUSD above Mezo's 2,000 floor (1,800 net + 200 gas compensation),
    // so that's the most it can repay; it already holds ~1,799 MUSD to repay with.
    uint256 constant AMOUNT = 15e18;
    uint256 constant FEE = 0.075e18; // 0.5% of 15

    VigilSafeModule module;
    MockAggregator oracle;
    IERC20Min musd = IERC20Min(MezoTestnet.MUSD);
    ITroveManager troveManager = ITroveManager(MezoTestnet.TROVE_MANAGER);
    ISafeAdmin safe = ISafeAdmin(PASSPORT_SAFE);
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC", string("https://rpc.test.mezo.org")));
        vm.etch(MezoTestnet.ORACLE, type(MockAggregator).runtimeCode);
        oracle = MockAggregator(MezoTestnet.ORACLE);
        oracle.set(int256(PRICE));

        module = new VigilSafeModule(
            MezoTestnet.MUSD, MezoTestnet.PRICE_FEED, MezoTestnet.TROVE_MANAGER, MezoTestnet.BORROWER_OPERATIONS
        );

        // One-time opt-in: enable the module (a Bitcoin-signed Safe tx in real life).
        vm.prank(PASSPORT_SAFE);
        safe.enableModule(address(module));
    }

    function _icr() internal view returns (uint256) {
        return troveManager.getCurrentICR(PASSPORT_SAFE, uint256(oracle.price()));
    }

    function _debt() internal view returns (uint256) {
        (, uint256 p, uint256 i,,,) = ITroveManagerTest(MezoTestnet.TROVE_MANAGER).getEntireDebtAndColl(PASSPORT_SAFE);
        return p + i;
    }

    function _configure(uint256[] memory triggers, uint256 guard, uint256 maxRescues) internal {
        vm.prank(PASSPORT_SAFE);
        module.configure(AMOUNT, guard, triggers, maxRescues);
    }

    function _one(uint256 t) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = t;
    }

    function test_IsARealPassportAccount() public view {
        assertTrue(safe.isModuleEnabled(SAFE_4337_MODULE), "OrangeKit's Safe4337Module");
        assertEq(safe.getOwners().length, 1, "single BitcoinSafeOwner");
        assertEq(troveManager.getTroveStatus(PASSPORT_SAFE), 1, "active MUSD loan");
    }

    function test_RescuesPassportAccountAsTheSafe() public {
        uint256 icr = _icr();
        _configure(_one(icr + 0.05e18), 0, 2); // trigger just above today's ratio
        uint256 debtBefore = _debt();
        uint256 musdBefore = musd.balanceOf(PASSPORT_SAFE);

        vm.prank(keeper);
        module.rescue(PASSPORT_SAFE, address(0), address(0));

        assertApproxEqAbs(_debt(), debtBefore - AMOUNT, 1e18, "the Safe's own debt repaid");
        assertEq(musd.balanceOf(PASSPORT_SAFE), musdBefore - AMOUNT - FEE, "from the Safe's own MUSD");
        assertEq(musd.balanceOf(keeper), FEE, "submitter earns the fee");
        assertGt(_icr(), icr, "ratio improved");
        (,, uint256 left, uint256 done) = module.configOf(PASSPORT_SAFE);
        assertEq(left, 1);
        assertEq(done, 1);
    }

    function test_Reject_ModuleNotEnabled() public {
        _configure(_one(_icr() + 0.05e18), 0, 1);
        vm.prank(PASSPORT_SAFE);
        safe.disableModule(SENTINEL, address(module)); // the module enabled last sits right after the sentinel
        vm.expectRevert(VigilSafeModule.ModuleNotEnabled.selector);
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_Reject_AboveTrigger() public {
        uint256 icr = _icr();
        _configure(_one(icr - 0.05e18), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(RescueRules.AboveTrigger.selector, icr, icr - 0.05e18));
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_Reject_NoRescuesLeft() public {
        _configure(_one(_icr() + 0.5e18), 0, 1);
        module.rescue(PASSPORT_SAFE, address(0), address(0));
        // Still under the trigger, but the Safe allowed only one rescue.
        vm.expectRevert(VigilSafeModule.NoRescuesLeft.selector);
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_Reject_MusdTooLow() public {
        _configure(_one(_icr() + 0.05e18), 0, 1);
        uint256 bal = musd.balanceOf(PASSPORT_SAFE);
        vm.prank(PASSPORT_SAFE);
        musd.transfer(makeAddr("elsewhere"), bal - 10e18);
        vm.expectRevert(abi.encodeWithSelector(VigilSafeModule.MusdTooLow.selector, 10e18, AMOUNT + FEE));
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_Reject_StaleOracle() public {
        _configure(_one(_icr() + 0.05e18), 0, 1);
        oracle.setStaleBy(61);
        vm.expectRevert(bytes("PriceFeed: Oracle is stale."));
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_SteppedTriggers() public {
        uint256 icr = _icr();
        uint256[] memory t = new uint256[](2);
        t[0] = icr + 0.05e18; // step 1 fires now
        t[1] = icr + 0.005e18; // step 2 needs the ratio to fall again, under a lower line
        _configure(t, 0, 2);
        module.rescue(PASSPORT_SAFE, address(0), address(0));
        assertEq(module.activeTrigger(PASSPORT_SAFE), t[1], "step 2's trigger is live");
        uint256 after1 = _icr();
        assertGt(after1, t[1], "the repay lifted the loan above step 2's line");
        vm.expectRevert(abi.encodeWithSelector(RescueRules.AboveTrigger.selector, after1, t[1]));
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_RedemptionGuardForPassportAccount() public {
        (bool found, uint256 ahead) = module.debtAhead(PASSPORT_SAFE);
        if (!found) return; // only meaningful while this account is within the first 60 troves
        _configure(new uint256[](0), ahead + 1, 1);
        (bool ok,,) = module.canRescue(PASSPORT_SAFE);
        assertTrue(ok);
        module.rescue(PASSPORT_SAFE, address(0), address(0));
    }

    function test_ConfigureOnlyAffectsTheCaller() public {
        _configure(_one(_icr() + 0.05e18), 0, 1);
        vm.prank(makeAddr("stranger"));
        module.configure(1e18, 0, new uint256[](0), 0);
        (uint256 amount,, uint256 left,) = module.configOf(PASSPORT_SAFE);
        assertEq(amount, AMOUNT);
        assertEq(left, 1);
    }

    function test_TriggerMustBeAboveLiquidationLine() public {
        vm.prank(PASSPORT_SAFE);
        vm.expectRevert(abi.encodeWithSelector(RescueRules.TriggerTooLow.selector, 1.1e18));
        module.configure(AMOUNT, 0, _one(1.1e18), 1);
    }
}
