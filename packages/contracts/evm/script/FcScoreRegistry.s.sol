// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {FcScoreRegistry} from "../src/FcScoreRegistry.sol";

contract FcScoreRegistryScript is Script {
    FcScoreRegistry public neynarScoreRegistry;

    function setUp() public {}

    function run() public {
        // Load deployer private key from env
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Derive deployer address
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        neynarScoreRegistry = new FcScoreRegistry(
            deployer // initial owner
        );

        vm.stopBroadcast();
    }
}
