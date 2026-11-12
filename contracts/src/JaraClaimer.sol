// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUBIScheme {
    function claim() external returns (bool);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title JaraClaimer
/// @notice A keyless stand-in for a Jara agent wallet. The owner (a verified GoodDollar
/// wallet) links this contract to their identity with `IdentityV4.connectAccount`. After
/// that anyone can call `claim()`, and the only thing it can ever do is collect that
/// identity's daily UBI and pass all of it straight to the owner.
///
/// There is no private key, no operator role and no upgrade path. Whoever runs Jara's
/// servers, or breaks into them, can do nothing here except pay the owner their own UBI.
contract JaraClaimer {
    address public immutable owner;
    IUBIScheme public immutable ubi;
    IERC20 public immutable gd;

    event Claimed(address indexed owner, uint256 amount);

    error NotOwner();
    error TransferFailed();
    error InvalidConfiguration();

    constructor(address owner_, IUBIScheme ubi_, IERC20 gd_) {
        if (owner_ == address(0) || address(ubi_) == address(0) || address(gd_) == address(0)) revert InvalidConfiguration();
        owner = owner_;
        ubi = ubi_;
        gd = gd_;
    }

    /// @notice Claim today's UBI and forward every G$ this contract holds to the owner.
    /// Callable by anyone: the caller only pays the gas.
    function claim() external returns (uint256 amount) {
        ubi.claim();
        amount = gd.balanceOf(address(this));
        if (amount > 0 && !gd.transfer(owner, amount)) revert TransferFailed();
        emit Claimed(owner, amount);
    }

    /// @notice The owner can recover any token sent here by mistake.
    function rescue(IERC20 token) external {
        if (msg.sender != owner) revert NotOwner();
        if (!token.transfer(owner, token.balanceOf(address(this)))) revert TransferFailed();
    }
}

/// @notice Deploys one claimer per owner at an address anyone can compute in advance.
contract JaraClaimerFactory {
    IUBIScheme public immutable ubi;
    IERC20 public immutable gd;

    event ClaimerCreated(address indexed owner, address claimer);

    constructor(IUBIScheme ubi_, IERC20 gd_) {
        ubi = ubi_;
        gd = gd_;
    }

    /// @notice Create the owner's claimer, or return it if it already exists.
    function create(address owner) external returns (address claimer) {
        claimer = claimerOf(owner);
        if (claimer.code.length > 0) return claimer;
        claimer = address(new JaraClaimer{salt: bytes32(uint256(uint160(owner)))}(owner, ubi, gd));
        emit ClaimerCreated(owner, claimer);
    }

    function claimerOf(address owner) public view returns (address) {
        bytes32 init = keccak256(abi.encodePacked(type(JaraClaimer).creationCode, abi.encode(owner, ubi, gd)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), init)))));
    }
}
