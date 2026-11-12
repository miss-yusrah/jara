// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title JaraTelemetry
/// @notice Public, append-only activity log for Jara (usejara.xyz), an AI agent that puts G$ to work.
/// Every user join and every G$ movement inside the app (UBI claims, deposits, AI payments, rewards,
/// refunds, bill payments) is recorded here so anyone can audit users and G$ circulation on Celo.
/// Users are identified only by their Jara wallet address. Activity from the demo mode (simulated G$)
/// is flagged and totalled separately so it is never mixed with real circulation.
contract JaraTelemetry {
    enum Kind {
        Joined, //     0: user connected a verified GoodDollar account
        Claimed, //    1: daily G$ UBI claimed into the user's jars
        Deposited, //  2: G$ added by the user
        AiSpent, //    3: G$ paid for a Jara AI answer
        BillPaid, //   4: G$ paid for a bill (airtime, data, electricity)
        Refunded, //   5: G$ returned to the user
        Rewarded //    6: G$ bonus paid to the user
    }

    struct Entry {
        address user; // the user's Jara wallet
        Kind kind;
        uint256 amount; // G$ in wei (18 decimals); 0 for Joined
        bytes32 ref; // unique id of the app event, prevents double counting
        bool demo; // true when produced in demo mode with simulated G$
    }

    uint256 private constant KINDS = 7;

    address public owner;
    mapping(address => bool) public isReporter;

    mapping(bytes32 => bool) public recorded;
    mapping(address => bool) public isUser;
    mapping(address => bool) public isDemoUser;

    uint256 public users;
    uint256 public demoUsers;
    uint256[KINDS] private _total;
    uint256[KINDS] private _count;
    uint256[KINDS] private _demoTotal;
    uint256[KINDS] private _demoCount;

    event Activity(
        address indexed user, Kind indexed kind, uint256 amount, bytes32 indexed ref, bool demo, uint64 at
    );
    event ReporterSet(address indexed reporter, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotReporter();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address reporter) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        if (reporter != address(0)) {
            isReporter[reporter] = true;
            emit ReporterSet(reporter, true);
        }
    }

    /// @notice Record a batch of app events. Events whose ref was already recorded are skipped.
    function record(Entry[] calldata entries) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        uint64 at = uint64(block.timestamp);
        for (uint256 i; i < entries.length; ++i) {
            Entry calldata e = entries[i];
            if (recorded[e.ref]) continue;
            if (e.user == address(0)) revert ZeroAddress();
            recorded[e.ref] = true;
            uint256 k = uint256(e.kind);
            if (e.demo) {
                _demoTotal[k] += e.amount;
                _demoCount[k] += 1;
                if (e.kind == Kind.Joined && !isDemoUser[e.user]) {
                    isDemoUser[e.user] = true;
                    demoUsers += 1;
                }
            } else {
                _total[k] += e.amount;
                _count[k] += 1;
                if (e.kind == Kind.Joined && !isUser[e.user]) {
                    isUser[e.user] = true;
                    users += 1;
                }
            }
            emit Activity(e.user, e.kind, e.amount, e.ref, e.demo, at);
        }
    }

    /// @notice Total G$ (wei) and number of events for a kind, real activity only.
    function totals(Kind kind) external view returns (uint256 amount, uint256 count) {
        return (_total[uint256(kind)], _count[uint256(kind)]);
    }

    /// @notice Same as totals() for demo-mode activity.
    function demoTotals(Kind kind) external view returns (uint256 amount, uint256 count) {
        return (_demoTotal[uint256(kind)], _demoCount[uint256(kind)]);
    }

    /// @notice Every kind at once: [Joined, Claimed, Deposited, AiSpent, BillPaid, Refunded, Rewarded].
    function summary(bool demo)
        external
        view
        returns (uint256 userCount, uint256[KINDS] memory amounts, uint256[KINDS] memory counts)
    {
        return demo ? (demoUsers, _demoTotal, _demoCount) : (users, _total, _count);
    }

    /// @notice Real G$ that moved through Jara: claimed + deposited + spent on AI and bills + rewards + refunds.
    function circulation(bool demo) external view returns (uint256 sum) {
        uint256[KINDS] storage t = demo ? _demoTotal : _total;
        for (uint256 k = 1; k < KINDS; ++k) sum += t[k];
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }
}
