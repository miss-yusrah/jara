// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JaraTelemetry} from "../src/JaraTelemetry.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract JaraTelemetryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    JaraTelemetry t;
    address reporter = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        t = new JaraTelemetry(reporter);
    }

    function _e(address u, JaraTelemetry.Kind k, uint256 a, string memory r, bool demo)
        internal
        pure
        returns (JaraTelemetry.Entry memory)
    {
        return JaraTelemetry.Entry(u, k, a, keccak256(bytes(r)), demo);
    }

    function test_recordsTotalsUsersAndSkipsDuplicates() public {
        JaraTelemetry.Entry[] memory b = new JaraTelemetry.Entry[](5);
        b[0] = _e(alice, JaraTelemetry.Kind.Joined, 0, "join:a", false);
        b[1] = _e(alice, JaraTelemetry.Kind.Claimed, 1400 ether, "act:1", false);
        b[2] = _e(alice, JaraTelemetry.Kind.AiSpent, 300 ether, "act:2", false);
        b[3] = _e(alice, JaraTelemetry.Kind.AiSpent, 300 ether, "act:2", false); // duplicate ref
        b[4] = _e(bob, JaraTelemetry.Kind.Joined, 0, "join:b", true); // demo
        vm.prank(reporter);
        t.record(b);

        require(t.users() == 1, "users");
        require(t.demoUsers() == 1, "demo users");
        (uint256 ai, uint256 aiCount) = t.totals(JaraTelemetry.Kind.AiSpent);
        require(ai == 300 ether && aiCount == 1, "ai totals");
        require(t.circulation(false) == 1700 ether, "circulation");
        require(t.circulation(true) == 0, "demo circulation");

        // re-sending the same batch changes nothing
        vm.prank(reporter);
        t.record(b);
        require(t.circulation(false) == 1700 ether, "idempotent");
    }

    function test_onlyReporterCanRecord() public {
        JaraTelemetry.Entry[] memory b = new JaraTelemetry.Entry[](1);
        b[0] = _e(alice, JaraTelemetry.Kind.Claimed, 1 ether, "x", false);
        vm.expectRevert(JaraTelemetry.NotReporter.selector);
        t.record(b);
    }

    function test_onlyOwnerManagesReporters() public {
        vm.prank(alice);
        vm.expectRevert(JaraTelemetry.NotOwner.selector);
        t.setReporter(alice, true);
        t.setReporter(alice, true);
        require(t.isReporter(alice), "set");
    }
}
