// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal views of the MUSD contracts Vigil touches.
/// Source of truth: https://github.com/mezo-org/musd (solidity/contracts).

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IPriceFeed {
    /// Reverts with "PriceFeed: Oracle is stale." when the oracle is older than 60 seconds.
    function fetchPrice() external view returns (uint256);
}

interface ITroveManager {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint8);
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        );
    function sortedTroves() external view returns (address);
}

/// Troves sorted by nominal ICR, highest first. Redemptions start at getLast() and walk getPrev().
interface ISortedTroves {
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
}

interface IBorrowerOperationsSignatures {
    /// Verifies an EIP-712 RepayMUSD(amount, borrower, nonce, deadline) signature from `borrower`,
    /// then repays `amount` of the borrower's debt, burning the MUSD from msg.sender.
    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes memory signature,
        uint256 deadline
    ) external;

    function getNonce(address user) external view returns (uint256);
}

interface IBorrowerOperations {
    /// Repays the caller's own trove. Only msg.sender's debt can be repaid this way.
    function repayMUSD(uint256 amount, address upperHint, address lowerHint) external;
}

/// The parts of a Safe (v1.4.1) a module uses. Mezo Passport accounts are Safes.
interface ISafe {
    function isModuleEnabled(address module) external view returns (bool);
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
}
