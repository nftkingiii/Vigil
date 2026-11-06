// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VigilReserve} from "../src/VigilReserve.sol";
import {VigilSafeModule} from "../src/VigilSafeModule.sol";

/// forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    // Mezo testnet (chain 31611)
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address constant BORROWER_OPERATIONS_SIGNATURES = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address constant BORROWER_OPERATIONS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;

    function run() external returns (VigilReserve vigil, VigilSafeModule module) {
        require(block.chainid == 31611, "Mezo testnet only");
        vm.startBroadcast();
        vigil = new VigilReserve(MUSD, PRICE_FEED, TROVE_MANAGER, BORROWER_OPERATIONS_SIGNATURES);
        module = new VigilSafeModule(MUSD, PRICE_FEED, TROVE_MANAGER, BORROWER_OPERATIONS);
        vm.stopBroadcast();
        console.log("VigilReserve", address(vigil));
        console.log("VigilSafeModule", address(module));
    }
}
