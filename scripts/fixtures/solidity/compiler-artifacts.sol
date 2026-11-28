// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Source-owned exact-selection fixture. Compiler outputs remain temporary.
library ExternalLibrary {
    function increment(uint256 value) external pure returns (uint256) {
        return value + 1;
    }
}

contract LinkedFixture {
    uint256 public immutable seed;
    constructor(uint256 initial) { seed = initial; }
    function increment(uint256 value) external pure returns (uint256) {
        return ExternalLibrary.increment(value);
    }
}

contract FirstFixture {
    function first(uint256 value) external pure returns (uint256) {
        return value + 1;
    }
}

contract SecondFixture {
    function second(bytes32 value) external pure returns (bytes32) {
        return value;
    }
}
