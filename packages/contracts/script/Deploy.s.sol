// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {AttnNames} from "../src/AttnNames.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;
        address mainAttn = 0x486b38df3E1E0719E055c07e0607655a92bd8c9C;
        bytes32 salt = keccak256("attn.names.v1");

        string[8] memory reserved = [
            "attn", "elpabl0", "chilldawg", "s0nderlabs",
            "mon", "27grey", "fano", "aidil"
        ];

        vm.startBroadcast();

        // 1. Deploy implementation (regular CREATE)
        AttnNames implementation = new AttnNames();

        // 2. Deploy proxy with CREATE2 for deterministic address
        bytes memory initData = abi.encodeCall(AttnNames.initialize, (deployer));
        ERC1967Proxy proxy = new ERC1967Proxy{salt: salt}(address(implementation), initData);
        AttnNames names = AttnNames(address(proxy));

        // 3. Pre-mint reserved names for free
        names.setRegistrationFee(0);
        for (uint256 i; i < reserved.length; i++) {
            names.register(reserved[i]);
        }
        names.setRegistrationFee(0.001 ether);

        // 4. Transfer all names to main attn address
        for (uint256 i; i < reserved.length; i++) {
            uint256 tokenId = uint256(names.namehash(reserved[i]));
            names.transferFrom(deployer, mainAttn, tokenId);
        }

        vm.stopBroadcast();

        console.log("Implementation:", address(implementation));
        console.log("Proxy (AttnNames):", address(proxy));
        console.log("Owner:", deployer);
        console.log("Names minted:", names.totalRegistrations());
        console.log("Names transferred to:", mainAttn);
    }
}
