// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IChallengeIdentity {
    function getWhitelistedRoot(address account) external view returns (address);
}

/// @notice User-submitted, free daily entries. Airtime prizes are delivered off-chain.
/// The completion signer attests quiz completion; it cannot submit entries for users.
/// No token approvals, transfers, custody or delegate calls.
contract JaraDailyChallenge {
    IChallengeIdentity public immutable identity;
    address public immutable completionSigner;
    address public immutable owner;
    uint256 public immutable startDay;
    uint256 public immutable endDay;
    uint256 public constant prizeNgn = 1000;
    uint256 public constant winnersPerDay = 5;
    bool public paused;

    struct Progress { uint256 lastDay; uint256 streak; }
    mapping(address => Progress) public progress;
    mapping(uint256 => mapping(address => bool)) public entered;
    mapping(uint256 => address[]) private participants;

    event DailyEntry(address indexed user, uint256 indexed day, bytes32 indexed challengeId, uint256 streak);
    event Paused(bool paused);
    error InvalidConfiguration();
    error NotOwner();
    error Closed();
    error NotVerifiedRoot();
    error AlreadyEntered();
    error InvalidCompletion();

    constructor(IChallengeIdentity identity_, address signer_, uint256 start_, uint256 end_) {
        if (address(identity_) == address(0) || signer_ == address(0) || start_ < today() || end_ < start_ || end_ - start_ >= 90) revert InvalidConfiguration();
        identity = identity_;
        completionSigner = signer_;
        owner = msg.sender;
        startDay = start_;
        endDay = end_;
    }

    /// @notice Lagos calendar day, shared with the web app. Lagos is UTC+1 year-round.
    function today() public view returns (uint256) { return (block.timestamp + 1 hours) / 1 days; }

    function completionHash(address user, uint256 day, bytes32 challengeId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), user, day, challengeId));
    }

    function enter(uint256 day, bytes32 challengeId, bytes calldata signature) external {
        if (paused || day != today() || day < startDay || day > endDay) revert Closed();
        // Require the verified root itself: the transaction sender is the participant.
        if (identity.getWhitelistedRoot(msg.sender) != msg.sender) revert NotVerifiedRoot();
        if (entered[day][msg.sender]) revert AlreadyEntered();
        if (challengeId == bytes32(0) || signature.length != 65) revert InvalidCompletion();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) revert InvalidCompletion();
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", completionHash(msg.sender, day, challengeId)));
        if (ecrecover(digest, v, r, s) != completionSigner) revert InvalidCompletion();
        entered[day][msg.sender] = true;
        participants[day].push(msg.sender);
        Progress storage p = progress[msg.sender];
        p.streak = p.lastDay + 1 == day ? p.streak + 1 : 1;
        p.lastDay = day;
        emit DailyEntry(msg.sender, day, challengeId, p.streak);
    }

    function entryCount(uint256 day) external view returns (uint256) { return participants[day].length; }
    function participantAt(uint256 day, uint256 index) external view returns (address) { return participants[day][index]; }

    function setPaused(bool value) external {
        if (msg.sender != owner) revert NotOwner();
        paused = value;
        emit Paused(value);
    }
}
