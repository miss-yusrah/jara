// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {JaraDailyChallenge, IChallengeIdentity} from "../src/JaraDailyChallenge.sol";

interface ChallengeVm {
    function prank(address) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert(bytes4) external;
}
contract ChallengeIdentity is IChallengeIdentity {
    mapping(address => address) public roots;
    function set(address account, address root) external { roots[account] = root; }
    function getWhitelistedRoot(address account) external view returns (address) { return roots[account]; }
}
contract JaraDailyChallengeTest {
    ChallengeVm constant vm = ChallengeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant SIGNER_KEY = 12345;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 quiz = keccak256("daily-quiz");
    ChallengeIdentity identity;
    JaraDailyChallenge challenge;
    uint256 day;

    function setUp() public {
        vm.chainId(42220);
        vm.warp(20000 days);
        identity = new ChallengeIdentity();
        identity.set(alice, alice);
        identity.set(bob, bob);
        day = (block.timestamp + 1 hours) / 1 days;
        challenge = new JaraDailyChallenge(identity, vm.addr(SIGNER_KEY), day, day + 13);
    }
    function ticket(address user, uint256 d) internal returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", challenge.completionHash(user, d, quiz)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
    function enter(address user, uint256 d) internal {
        bytes memory sig = ticket(user, d);
        vm.prank(user);
        challenge.enter(d, quiz, sig);
    }
    function test_directVerifiedEntryIsEnumerable() public {
        enter(alice, day);
        require(challenge.entered(day, alice), "entry");
        require(challenge.entryCount(day) == 1 && challenge.participantAt(day, 0) == alice, "enumerable");
        (uint256 last, uint256 streak) = challenge.progress(alice);
        require(last == day && streak == 1, "progress");
    }
    function test_duplicateRejected() public {
        enter(alice, day);
        bytes memory sig = ticket(alice, day);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.AlreadyEntered.selector);
        challenge.enter(day, quiz, sig);
        require(challenge.entryCount(day) == 1, "no duplicate");
    }
    function test_anotherWalletCannotUseTicket() public {
        bytes memory sig = ticket(alice, day);
        vm.prank(bob); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        challenge.enter(day, quiz, sig);
    }
    function test_linkedAgentCannotEnterAsAnotherPerson() public {
        identity.set(bob, alice);
        bytes memory sig = ticket(bob, day);
        vm.prank(bob); vm.expectRevert(JaraDailyChallenge.NotVerifiedRoot.selector);
        challenge.enter(day, quiz, sig);
    }
    function test_expiredVerificationIsRejected() public {
        bytes memory sig = ticket(alice, day);
        identity.set(alice, address(0));
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.NotVerifiedRoot.selector);
        challenge.enter(day, quiz, sig);
    }
    function test_ticketCannotMoveAcrossDaysOrQuizzes() public {
        bytes memory sig = ticket(alice, day);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        challenge.enter(day, keccak256("other-quiz"), sig);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        challenge.enter(day + 1, quiz, sig);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.Closed.selector);
        challenge.enter(day, quiz, sig);
    }
    function test_ticketCannotMoveAcrossContractsOrChains() public {
        bytes memory sig = ticket(alice, day);
        JaraDailyChallenge other = new JaraDailyChallenge(identity, vm.addr(SIGNER_KEY), day, day + 13);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        other.enter(day, quiz, sig);
        vm.chainId(1);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        challenge.enter(day, quiz, sig);
    }
    function test_streakAndMissedDay() public {
        enter(alice, day);
        vm.warp(block.timestamp + 1 days); enter(alice, day + 1);
        (, uint256 streak) = challenge.progress(alice);
        require(streak == 2, "consecutive");
        vm.warp(block.timestamp + 2 days); enter(alice, day + 3);
        (, streak) = challenge.progress(alice);
        require(streak == 1 && challenge.entered(day, alice), "reset preserves history");
    }
    function test_lagosMidnightIsTheBoundary() public {
        vm.warp((day + 1) * 1 days - 1 hours - 1);
        require(challenge.today() == day, "before Lagos midnight");
        enter(alice, day);
        vm.warp(block.timestamp + 1);
        require(challenge.today() == day + 1, "at Lagos midnight");
        enter(alice, day + 1);
    }
    function test_pausePreservesEntriesAndIsOwnerOnly() public {
        enter(alice, day);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.NotOwner.selector);
        challenge.setPaused(true);
        challenge.setPaused(true);
        bytes memory sig = ticket(bob, day);
        vm.prank(bob); vm.expectRevert(JaraDailyChallenge.Closed.selector);
        challenge.enter(day, quiz, sig);
        require(challenge.entryCount(day) == 1, "history preserved");
        challenge.setPaused(false); enter(bob, day);
    }
    function test_campaignEndAndStartAreEnforced() public {
        vm.warp(block.timestamp + 14 days);
        bytes memory sig = ticket(alice, day + 14);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.Closed.selector);
        challenge.enter(day + 14, quiz, sig);
        JaraDailyChallenge future = new JaraDailyChallenge(identity, vm.addr(SIGNER_KEY), day + 15, day + 20);
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.Closed.selector);
        future.enter(day + 14, quiz, sig);
    }
    function test_invalidSignatureLengthRejected() public {
        vm.prank(alice); vm.expectRevert(JaraDailyChallenge.InvalidCompletion.selector);
        challenge.enter(day, quiz, hex"00");
    }
}
