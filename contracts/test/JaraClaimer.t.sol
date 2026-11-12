// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JaraClaimer, JaraClaimerFactory, IUBIScheme, IERC20} from "../src/JaraClaimer.sol";
import {JaraSpending, ISpendingToken} from "../src/JaraSpending.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function envOr(string calldata, address) external view returns (address);
    function skip(bool) external;
}

interface IIdentity {
    function connectAccount(address account) external;
    function getWhitelistedRoot(address account) external view returns (address);
    function disconnectAccount(address account) external;
}
interface IApproval { function approve(address spender, uint256 amount) external returns (bool); }

interface IUBIView {
    function checkEntitlement(address member) external view returns (uint256);
}

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Pays the caller a fixed amount once per call, like UBIScheme pays a connected account.
contract MockUBI {
    MockToken public immutable token;
    uint256 public daily = 100 ether;

    constructor(MockToken token_) {
        token = token_;
    }

    function claim() external returns (bool) {
        token.mint(msg.sender, daily);
        return true;
    }
}

contract JaraClaimerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockToken token;
    MockUBI ubi;
    JaraClaimerFactory factory;
    address owner = address(0xA11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        token = new MockToken();
        ubi = new MockUBI(token);
        factory = new JaraClaimerFactory(IUBIScheme(address(ubi)), IERC20(address(token)));
    }

    function test_anyoneCanTriggerButOnlyTheOwnerIsPaid() public {
        JaraClaimer claimer = JaraClaimer(factory.create(owner));
        vm.prank(stranger);
        uint256 amount = claimer.claim();
        require(amount == 100 ether, "amount");
        require(token.balanceOf(owner) == 100 ether, "owner paid");
        require(token.balanceOf(stranger) == 0, "caller gets nothing");
        require(token.balanceOf(address(claimer)) == 0, "nothing is held");
    }

    function test_addressIsPredictableAndCreateIsIdempotent() public {
        address predicted = factory.claimerOf(owner);
        require(factory.create(owner) == predicted, "predicted");
        require(factory.create(owner) == predicted, "idempotent");
        require(factory.claimerOf(stranger) != predicted, "one per owner");
        require(JaraClaimer(predicted).owner() == owner, "owner");
    }

    function test_onlyTheOwnerCanRescueStrayTokens() public {
        JaraClaimer claimer = JaraClaimer(factory.create(owner));
        MockToken other = new MockToken();
        other.mint(address(claimer), 5 ether);
        vm.prank(stranger);
        vm.expectRevert(JaraClaimer.NotOwner.selector);
        claimer.rescue(IERC20(address(other)));
        vm.prank(owner);
        claimer.rescue(IERC20(address(other)));
        require(other.balanceOf(owner) == 5 ether, "rescued");
    }
}

/// Runs only against a Celo mainnet fork, with GD_ROOT set to a verified GoodDollar wallet
/// (it is a no-op otherwise). Celo runs a newer EVM than this project compiles for, and the
/// public RPC's nodes lag each other, so pin both:
///   GD_ROOT=0x… forge test --match-contract JaraClaimerForkTest --evm-version cancun \
///     --fork-url https://forno.celo.org --fork-block-number $(( $(cast block-number --rpc-url https://forno.celo.org) - 50 ))
/// It answers the one open question for this design: do GoodDollar's live Identity and
/// UBIScheme contracts accept a contract as a connected account that claims?
contract JaraClaimerForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IIdentity constant IDENTITY = IIdentity(0xC361A6E67822a0EDc17D899227dd9FC50BD62F42);
    address constant UBI = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1;
    IERC20 constant GD = IERC20(0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A);

    event Result(string what, uint256 value);

    function test_fork_aContractCanBeLinkedAndClaimsStraightToItsOwner() public {
        address root = vm.envOr("GD_ROOT", address(0));
        vm.skip(root == address(0)); // visibly skipped without a fork fixture
        require(IDENTITY.getWhitelistedRoot(root) == root, "GD_ROOT must be a verified root wallet");

        JaraClaimerFactory factory = new JaraClaimerFactory(IUBIScheme(UBI), GD);
        // Onboarding must work before deployment, without spending sponsor gas
        // for someone who merely supplied a public root address.
        JaraClaimer claimer = JaraClaimer(factory.claimerOf(root));
        address oldAgent = address(0x1234567);
        vm.prank(root);
        IDENTITY.connectAccount(oldAgent);
        vm.prank(root);
        IDENTITY.disconnectAccount(oldAgent);
        require(IDENTITY.getWhitelistedRoot(oldAgent) == address(0), "old key loses identity rights");

        // The owner links the contract exactly as they link a Jara wallet today.
        vm.prank(root);
        IDENTITY.connectAccount(address(claimer));
        require(IDENTITY.getWhitelistedRoot(address(claimer)) == root, "contract resolves to the owner's identity");
        require(factory.create(root) == address(claimer), "deploy linked counterfactual address");

        // A new UBI day, so there is something to claim.
        vm.warp(block.timestamp + 1 days);
        emit Result("entitlement before claim", IUBIView(UBI).checkEntitlement(root));

        uint256 before = GD.balanceOf(root);
        vm.prank(address(0xCAFE)); // someone with no rights at all pays the gas
        uint256 amount = claimer.claim();
        emit Result("claimed", amount);

        require(amount > 0, "claimed something");
        require(GD.balanceOf(root) == before + amount, "all of it reached the owner");
        require(GD.balanceOf(address(claimer)) == 0, "the contract holds nothing");
        require(GD.balanceOf(address(0xCAFE)) == 0, "the caller got nothing");

        // Real G$ supports policy-mediated transferFrom; the operator cannot exceed
        // the owner's on-chain daily cap even with a larger ERC20 allowance.
        JaraSpending spending = new JaraSpending(ISpendingToken(address(GD)), address(0xCAFE), address(0xBEEF));
        vm.prank(root);
        IApproval(address(GD)).approve(address(spending), amount);
        vm.prank(root);
        spending.configure(amount, amount / 2, block.timestamp + 30 days);
        uint256 beforeRecipient = GD.balanceOf(address(0xBEEF));
        vm.prank(address(0xCAFE));
        spending.charge(root, amount / 2, bytes32(uint256(1)));
        require(GD.balanceOf(address(0xBEEF)) == beforeRecipient + amount / 2, "policy recipient paid");
        vm.prank(address(0xCAFE));
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        spending.charge(root, 1, bytes32(uint256(2)));

        vm.prank(root);
        IDENTITY.disconnectAccount(address(claimer));
        require(IDENTITY.getWhitelistedRoot(address(claimer)) == address(0), "owner can revoke keyless claims");
    }
}
