// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JaraSpending, ISpendingToken} from "../src/JaraSpending.sol";

interface SpendingVm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}
contract SpendingToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public fail;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function setFail(bool value) external { fail = value; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
contract JaraSpendingTest {
    SpendingVm constant vm = SpendingVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SpendingToken token;
    JaraSpending spending;
    address owner = address(0xA11CE);
    address operator = address(0xB0B);
    address recipient = address(0xCAFE);
    address attacker = address(0xBAD);

    function setUp() public {
        vm.warp(10 days + 1 hours);
        token = new SpendingToken();
        spending = new JaraSpending(ISpendingToken(address(token)), operator, recipient);
        token.mint(owner, 10000 ether);
        vm.prank(owner);
        token.approve(address(spending), 5000 ether);
        vm.prank(owner);
        spending.configure(5000 ether, 1000 ether, block.timestamp + 30 days);
    }
    function charge(uint256 amount, uint256 id) internal {
        vm.prank(operator);
        spending.charge(owner, amount, bytes32(id));
    }
    function test_onlyOperatorAndFixedRecipient() public {
        vm.prank(attacker);
        vm.expectRevert(JaraSpending.NotOperator.selector);
        spending.charge(owner, 1 ether, bytes32(uint256(1)));
        charge(100 ether, 1);
        require(token.balanceOf(recipient) == 100 ether, "recipient");
        require(token.balanceOf(operator) == 0 && token.balanceOf(attacker) == 0, "no arbitrary receiver");
    }
    function test_operatorCannotGrantItselfAnOwnerPolicy() public {
        vm.prank(operator);
        spending.configure(type(uint128).max, type(uint128).max, block.timestamp + 365 days);
        require(spending.available(owner) == 1000 ether, "owner limit unchanged");
    }
    function test_dailyLimitResetsButTotalDoesNot() public {
        for (uint256 day; day < 5; day++) {
            charge(1000 ether, day + 1);
            require(spending.available(owner) == 0, "daily exhausted");
            vm.warp(block.timestamp + 1 days);
        }
        require(spending.available(owner) == 0, "total exhausted");
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        charge(1, 6);
    }
    function test_replayRejectedEvenOnAnotherDay() public {
        charge(100 ether, 1);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(JaraSpending.AlreadyCharged.selector);
        charge(100 ether, 1);
    }
    function test_expiryIsEnforcedAtExactTimestamp() public {
        vm.warp(block.timestamp + 30 days);
        require(spending.available(owner) == 0, "expired");
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        charge(1, 1);
    }
    function test_revokeAndReenableDoesNotResetDailyUsage() public {
        charge(700 ether, 1);
        vm.prank(owner);
        spending.configure(0, 0, 0);
        require(spending.available(owner) == 0, "revoked");
        vm.prank(owner);
        spending.configure(5000 ether, 1000 ether, block.timestamp + 30 days);
        require(spending.available(owner) == 300 ether, "usage retained");
    }
    function test_tokenAllowanceAlsoBoundsSpending() public {
        vm.prank(owner);
        token.approve(address(spending), 5 ether);
        require(spending.available(owner) == 5 ether, "token allowance bounds");
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        charge(6 ether, 1);
    }
    function test_failedTransferRestoresPolicyAndReplaySlot() public {
        token.setFail(true);
        vm.expectRevert(JaraSpending.TransferFailed.selector);
        charge(100 ether, 1);
        require(spending.available(owner) == 1000 ether, "policy rolled back");
        token.setFail(false);
        charge(100 ether, 1);
    }
    function test_noPolicyAndZeroAmountCannotCharge() public {
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        charge(0, 1);
        vm.prank(operator);
        vm.expectRevert(JaraSpending.LimitExceeded.selector);
        spending.charge(attacker, 1, bytes32(uint256(1)));
    }
    function testFuzz_dailyCapAlwaysBoundsACharge(uint128 amount) public {
        if (amount == 0 || amount > 1000 ether) {
            vm.expectRevert(JaraSpending.LimitExceeded.selector);
            charge(amount, 1);
        } else {
            charge(amount, 1);
            require(spending.available(owner) == 1000 ether - amount, "daily accounting");
        }
    }
}
