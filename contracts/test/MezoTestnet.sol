// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// MUSD testnet ("matsnet", chain 31611) addresses.
/// From mezo-org/musd solidity/artifacts/deployments/matsnet, read back on-chain 2026-10-12.
library MezoTestnet {
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address internal constant BORROWER_OPERATIONS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address internal constant BORROWER_OPERATIONS_SIGNATURES = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address internal constant PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address internal constant ORACLE = 0x7b7c000000000000000000000000000000000015;
}

interface IBorrowerOperationsTest {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;
    function repayMUSD(uint256 amount, address upperHint, address lowerHint) external;
    function withdrawMUSD(uint256 amount, address upperHint, address lowerHint) external;
}

interface ITroveManagerTest {
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}
