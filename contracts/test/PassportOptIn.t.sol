// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {VigilSafeModule} from "../src/VigilSafeModule.sol";
import {IERC20Min, ITroveManager} from "../src/interfaces/IMezo.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MezoTestnet, ITroveManagerTest} from "./MezoTestnet.sol";

interface IOrangeKitSafeFactory {
    function deploySafe(bytes20 truncatedBitcoinAddress) external returns (address safe, address bitcoinSafeOwner);
}

interface ISafeFull {
    function nonce() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
}

/// End to end on a fork of Mezo testnet, with no pranks on the account: a Bitcoin key gets a Mezo
/// Passport account from Mezo's own OrangeKit factory, opens a MUSD loan with a Bitcoin-signed Safe
/// transaction, opts in to Vigil with ONE Bitcoin-signed batch (enable module + configure, through
/// Safe's MultiSendCallOnly), and is rescued by a keeper. Signatures are BIP-137 over the Safe tx
/// hash as a hex string, the format Bitcoin wallets' signMessage produces and OrangeKit expects,
/// verified by Mezo's real BitcoinSafeOwner contract.
contract PassportOptInForkTest is Test {
    IOrangeKitSafeFactory constant FACTORY = IOrangeKitSafeFactory(0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052);
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;

    uint256 constant BTC_KEY = 0xB17C0175;
    Vm.Wallet btc;
    bytes20 truncated;
    ISafeFull safe;
    address owner;

    VigilSafeModule module;
    MockAggregator oracle;
    ITroveManager troveManager = ITroveManager(MezoTestnet.TROVE_MANAGER);
    IERC20Min musd = IERC20Min(MezoTestnet.MUSD);

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC", string("https://rpc.test.mezo.org")));
        vm.etch(MezoTestnet.ORACLE, type(MockAggregator).runtimeCode);
        oracle = MockAggregator(MezoTestnet.ORACLE);
        oracle.set(int256(80_000e18));
        module = new VigilSafeModule(
            MezoTestnet.MUSD, MezoTestnet.PRICE_FEED, MezoTestnet.TROVE_MANAGER, MezoTestnet.BORROWER_OPERATIONS
        );

        // The Bitcoin identity: compressed P2PKH / P2WPKH share hash160(compressed pubkey).
        btc = vm.createWallet(BTC_KEY);
        bytes memory compressed = abi.encodePacked(uint8(2 + (btc.publicKeyY & 1)), bytes32(btc.publicKeyX));
        truncated = ripemd160(abi.encodePacked(sha256(compressed)));
        address safeAddr;
        (safeAddr, owner) = FACTORY.deploySafe(truncated);
        safe = ISafeFull(safeAddr);
        vm.deal(safeAddr, 1 ether); // BTC for collateral
    }

    /// What a Bitcoin wallet's signMessage(hex string) gives, wrapped the way OrangeKit submits it.
    function _btcSign(uint256 key, Vm.Wallet memory w, bytes32 digest) internal returns (bytes memory) {
        bytes memory text = bytes(_hex(digest)); // 64 lowercase hex characters, no 0x
        bytes32 m = sha256(abi.encodePacked(sha256(abi.encodePacked("\x18Bitcoin Signed Message:\n", uint8(text.length), text))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, m);
        // BIP-137 compressed P2PKH header (v + 4), plus OrangeKit's "signed as hex text" high bit.
        bytes memory bitcoinSig = abi.encodePacked(r, s, uint8(v + 4 + 128), bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        // Safe contract signature: {owner}{offset 65}{type 0}{length}{data}.
        return abi.encodePacked(bytes32(uint256(uint160(owner))), uint256(65), uint8(0), uint256(bitcoinSig.length), bitcoinSig);
    }

    function _exec(address to, uint256 value, bytes memory data, uint8 op) internal returns (bool) {
        bytes32 h = safe.getTransactionHash(to, value, data, op, 0, 0, 0, address(0), address(0), safe.nonce());
        // Anyone may relay a signed Safe tx; Vigil's service does this for the web page.
        return safe.execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), _btcSign(BTC_KEY, btc, h));
    }

    function test_BitcoinKeyOptsInWithOneSignatureAndIsRescued() public {
        // 1. Open a MUSD loan from the Passport account (Bitcoin-signed).
        assertTrue(_exec(MezoTestnet.BORROWER_OPERATIONS, 0.05 ether, abi.encodeWithSignature("openTrove(uint256,address,address)", 2_500e18, address(0), address(0)), CALL));
        assertEq(troveManager.getTroveStatus(address(safe)), 1, "loan open");
        uint256 icr = troveManager.getCurrentICR(address(safe), 80_000e18);

        // 2. Opt in to Vigil: ONE Bitcoin signature over a MultiSend batch.
        uint256[] memory triggers = new uint256[](1);
        triggers[0] = 1.4e18;
        bytes memory enable = abi.encodeWithSignature("enableModule(address)", address(module));
        bytes memory configure = abi.encodeCall(VigilSafeModule.configure, (300e18, 0, triggers, 2));
        bytes memory batch = abi.encodePacked(
            CALL, address(safe), uint256(0), uint256(enable.length), enable,
            CALL, address(module), uint256(0), uint256(configure.length), configure
        );
        assertTrue(_exec(MULTISEND_CALL_ONLY, 0, abi.encodeWithSignature("multiSend(bytes)", batch), DELEGATECALL));
        assertTrue(safe.isModuleEnabled(address(module)), "module enabled by the Bitcoin key");
        (uint256 amount,, uint256 left,) = module.configOf(address(safe));
        assertEq(amount, 300e18);
        assertEq(left, 2);

        // 3. Price falls; anyone submits the rescue; the Safe's own MUSD repays its own debt.
        assertGt(icr, 1.4e18);
        oracle.set(int256(70_000e18));
        assertLt(troveManager.getCurrentICR(address(safe), 70_000e18), 1.4e18);
        (, uint256 p0, uint256 i0,,,) = ITroveManagerTest(MezoTestnet.TROVE_MANAGER).getEntireDebtAndColl(address(safe));
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        module.rescue(address(safe), address(0), address(0));
        (, uint256 p1, uint256 i1,,,) = ITroveManagerTest(MezoTestnet.TROVE_MANAGER).getEntireDebtAndColl(address(safe));
        assertApproxEqAbs(p0 + i0 - (p1 + i1), 300e18, 1e18, "300 MUSD repaid");
        assertEq(musd.balanceOf(keeper), 1.5e18, "fee to the submitter");
    }

    function test_Reject_WrongBitcoinKey() public {
        Vm.Wallet memory other = vm.createWallet(0xBAD);
        bytes memory data = abi.encodeWithSignature("enableModule(address)", address(module));
        bytes32 h = safe.getTransactionHash(address(safe), 0, data, CALL, 0, 0, 0, address(0), address(0), safe.nonce());
        bytes memory sig = _btcSign(0xBAD, other, h);
        vm.expectRevert(); // BitcoinSafeOwner rejects it: wrong hash160
        safe.execTransaction(address(safe), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), sig);
        assertFalse(safe.isModuleEnabled(address(module)));
    }

    function _hex(bytes32 b) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            out[2 * i] = alphabet[uint8(b[i]) >> 4];
            out[2 * i + 1] = alphabet[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
