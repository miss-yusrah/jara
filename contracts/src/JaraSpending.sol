// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISpendingToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice An owner-authorized, bounded allowance. The operator cannot change the
/// recipient, raise a limit, extend expiry, or reset a day's consumed budget.
/// A compromised operator can still consume the remaining authorized budget.
/// No proxy, admin, arbitrary calls, token custody, or withdrawal authority.
contract JaraSpending {
    ISpendingToken public immutable gd;
    address public immutable operator;
    address public immutable recipient;

    struct Policy {
        uint256 remaining;
        uint256 dailyLimit;
        uint256 validUntil;
        uint256 day;
        uint256 spent;
    }
    mapping(address => Policy) public policies;
    mapping(bytes32 => bool) public used;

    error InvalidConfiguration();
    error NotOperator();
    error LimitExceeded();
    error AlreadyCharged();
    error TransferFailed();
    event Configured(address indexed owner, uint256 total, uint256 dailyLimit, uint256 validUntil);
    event Charged(bytes32 indexed id, address indexed owner, uint256 amount);

    constructor(ISpendingToken gd_, address operator_, address recipient_) {
        if (address(gd_) == address(0) || operator_ == address(0) || recipient_ == address(0)) revert InvalidConfiguration();
        gd = gd_;
        operator = operator_;
        recipient = recipient_;
    }

    /// @notice Only the wallet owner can grant, change or revoke its policy.
    /// Reconfiguration preserves today's usage, including after revoke/re-enable.
    function configure(uint256 total, uint256 dailyLimit, uint256 validUntil) external {
        if (total > 0 && (dailyLimit == 0 || validUntil <= block.timestamp)) revert InvalidConfiguration();
        Policy storage p = policies[msg.sender];
        p.remaining = total;
        p.dailyLimit = dailyLimit;
        p.validUntil = validUntil;
        emit Configured(msg.sender, total, dailyLimit, validUntil);
    }

    function available(address owner) public view returns (uint256) {
        Policy memory p = policies[owner];
        if (block.timestamp >= p.validUntil) return 0;
        uint256 spent = p.day == block.timestamp / 1 days ? p.spent : 0;
        uint256 left = p.dailyLimit > spent ? p.dailyLimit - spent : 0;
        if (p.remaining < left) left = p.remaining;
        uint256 allowance = gd.allowance(owner, address(this));
        return allowance < left ? allowance : left;
    }

    function charge(address owner, uint256 amount, bytes32 id) external {
        if (msg.sender != operator) revert NotOperator();
        if (used[id]) revert AlreadyCharged();
        if (amount == 0 || amount > available(owner)) revert LimitExceeded();
        used[id] = true;
        Policy storage p = policies[owner];
        uint256 day = block.timestamp / 1 days;
        if (p.day != day) { p.day = day; p.spent = 0; }
        p.spent += amount;
        p.remaining -= amount;
        if (!gd.transferFrom(owner, recipient, amount)) revert TransferFailed();
        emit Charged(id, owner, amount);
    }
}
