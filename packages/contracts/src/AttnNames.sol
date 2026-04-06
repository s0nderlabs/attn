// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract AttnNames is
    Initializable,
    ERC721Upgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    // ── Structs ────────────────────────────────────────────────────────────

    struct Listing {
        uint256 price;
    }

    struct Offer {
        uint256 amount;
        uint256 expiresAt;
    }

    // ── ERC-7201 Namespaced Storage ────────────────────────────────────────

    /// @custom:storage-location erc7201:attn.storage.AttnNames
    struct AttnNamesStorage {
        uint256 registrationFee;
        uint256 totalRegistrations;
        uint256 protocolFeeBps;
        uint256 totalOfferEscrow;
        mapping(bytes32 node => string label) nodeToLabel;
        mapping(bytes32 labelHash => bytes32 node) labelHashToNode;
        mapping(address owner => bytes32 node) primaryNode;
        mapping(uint256 tokenId => Listing) listings;
        mapping(uint256 tokenId => mapping(address buyer => Offer)) offers;
    }

    // keccak256(abi.encode(uint256(keccak256("attn.storage.AttnNames")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ATTN_NAMES_STORAGE_SLOT =
        0xdc792a5f125f34651a5da19855e8f7b03830e77d90503585b5205403e0bdd400;

    function _s() private pure returns (AttnNamesStorage storage $) {
        assembly {
            $.slot := ATTN_NAMES_STORAGE_SLOT
        }
    }

    // ── Constants ──────────────────────────────────────────────────────────

    // namehash("attn") = keccak256(abi.encodePacked(bytes32(0), keccak256("attn")))
    bytes32 public constant ATTN_NODE =
        0x3277e87b27c15649ea7029989ad4accf636e5887ea8aa196e8159f0bcff0787f;

    uint256 private constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%

    // ── Events ─────────────────────────────────────────────────────────────

    event NameRegistered(bytes32 indexed node, string label, address indexed owner, uint256 tokenId);
    event PrimaryNameSet(address indexed owner, string label, bytes32 indexed node);
    event PrimaryNameCleared(address indexed owner);
    event NameListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event NameDelisted(uint256 indexed tokenId);
    event NameSold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);
    event OfferMade(uint256 indexed tokenId, address indexed buyer, uint256 amount, uint256 expiresAt);
    event OfferCancelled(uint256 indexed tokenId, address indexed buyer);
    event OfferAccepted(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 amount);
    event SellerPaymentFailed(address indexed seller, uint256 amount);
    event RegistrationFeeUpdated(uint256 oldFee, uint256 newFee);
    event ProtocolFeeUpdated(uint256 oldBps, uint256 newBps);
    event Withdrawn(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────

    error NameAlreadyRegistered(string label);
    error InsufficientFee(uint256 required, uint256 provided);
    error RefundFailed();
    error LabelTooShort(uint256 length);
    error LabelTooLong(uint256 length);
    error LabelLeadingHyphen();
    error LabelTrailingHyphen();
    error LabelInvalidCharacter(bytes1 char);
    error NotNameOwner();
    error NoPrimaryName();
    error PriceCannotBeZero();
    error NotListed(uint256 tokenId);
    error CannotBuyOwnName();
    error InsufficientPayment(uint256 required, uint256 provided);
    error OfferAmountZero();
    error OfferAlreadyExpired();
    error NoOfferExists();
    error OfferExpired();
    error NothingToWithdraw();
    error WithdrawFailed();
    error ProtocolFeeTooHigh();

    // ── Constructor + Initializer ──────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __ERC721_init("attn names", "ATTN");
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        AttnNamesStorage storage $ = _s();
        $.registrationFee = 0.001 ether;
        $.protocolFeeBps = 250;
    }

    // ── Namehash ───────────────────────────────────────────────────────────

    function namehash(string memory label) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(ATTN_NODE, keccak256(bytes(label))));
    }

    // ── Label Validation ───────────────────────────────────────────────────

    function _validateLabel(string calldata label) internal pure {
        bytes memory b = bytes(label);
        uint256 len = b.length;

        if (len < 3) revert LabelTooShort(len);
        if (len > 32) revert LabelTooLong(len);
        if (b[0] == 0x2d) revert LabelLeadingHyphen();
        if (b[len - 1] == 0x2d) revert LabelTrailingHyphen();

        for (uint256 i; i < len;) {
            bytes1 c = b[i];
            bool valid = (c >= 0x61 && c <= 0x7a) // a-z
                || (c >= 0x30 && c <= 0x39) // 0-9
                || (c == 0x2d); // -
            if (!valid) revert LabelInvalidCharacter(c);
            unchecked { ++i; }
        }
    }

    // ── Registration ───────────────────────────────────────────────────────

    function register(string calldata label) external payable nonReentrant whenNotPaused {
        AttnNamesStorage storage $ = _s();

        _validateLabel(label);

        bytes32 labelHash = keccak256(bytes(label));
        if ($.labelHashToNode[labelHash] != bytes32(0)) revert NameAlreadyRegistered(label);

        uint256 fee = $.registrationFee;
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        bytes32 node = keccak256(abi.encodePacked(ATTN_NODE, labelHash));
        uint256 tokenId = uint256(node);

        $.nodeToLabel[node] = label;
        $.labelHashToNode[labelHash] = node;
        $.totalRegistrations += 1;

        _mint(msg.sender, tokenId);

        if ($.primaryNode[msg.sender] == bytes32(0)) {
            $.primaryNode[msg.sender] = node;
            emit PrimaryNameSet(msg.sender, label, node);
        }

        emit NameRegistered(node, label, msg.sender, tokenId);

        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ── Resolution ─────────────────────────────────────────────────────────

    function resolve(string calldata label) external view returns (address owner_, bytes32 node) {
        node = namehash(label);
        owner_ = _ownerOf(uint256(node));
    }

    function primaryNameOf(address addr) external view returns (string memory) {
        AttnNamesStorage storage $ = _s();
        bytes32 node = $.primaryNode[addr];
        if (node == bytes32(0)) return "";
        return $.nodeToLabel[node];
    }

    function labelOf(bytes32 node) external view returns (string memory) {
        return _s().nodeToLabel[node];
    }

    // ── Primary Name ───────────────────────────────────────────────────────

    function setPrimaryName(string calldata label) external {
        bytes32 node = namehash(label);
        if (ownerOf(uint256(node)) != msg.sender) revert NotNameOwner();

        _s().primaryNode[msg.sender] = node;
        emit PrimaryNameSet(msg.sender, label, node);
    }

    function clearPrimaryName() external {
        AttnNamesStorage storage $ = _s();
        if ($.primaryNode[msg.sender] == bytes32(0)) revert NoPrimaryName();
        delete $.primaryNode[msg.sender];
        emit PrimaryNameCleared(msg.sender);
    }

    // ── ERC-721 Override ───────────────────────────────────────────────────

    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address from)
    {
        from = super._update(to, tokenId, auth);

        AttnNamesStorage storage $ = _s();

        // Auto-delist on any transfer
        if ($.listings[tokenId].price > 0) {
            delete $.listings[tokenId];
            emit NameDelisted(tokenId);
        }

        // Clear primary if sender's primary was this name
        if (from != address(0)) {
            bytes32 node = bytes32(tokenId);
            if ($.primaryNode[from] == node) {
                delete $.primaryNode[from];
                emit PrimaryNameCleared(from);
            }
        }

        return from;
    }

    // ── Marketplace: Listings ──────────────────────────────────────────────

    function listForSale(uint256 tokenId, uint256 price) external {
        if (ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        if (price == 0) revert PriceCannotBeZero();

        _s().listings[tokenId] = Listing({price: price});
        emit NameListed(tokenId, msg.sender, price);
    }

    function delistName(uint256 tokenId) external {
        AttnNamesStorage storage $ = _s();
        if ($.listings[tokenId].price == 0) revert NotListed(tokenId);
        if (ownerOf(tokenId) != msg.sender) revert NotNameOwner();

        delete $.listings[tokenId];
        emit NameDelisted(tokenId);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        AttnNamesStorage storage $ = _s();
        Listing memory listing = $.listings[tokenId];
        if (listing.price == 0) revert NotListed(tokenId);

        address seller = ownerOf(tokenId);
        if (seller == msg.sender) revert CannotBuyOwnName();
        if (msg.value < listing.price) revert InsufficientPayment(listing.price, msg.value);

        // CEI: clear listing before external calls
        delete $.listings[tokenId];

        uint256 protocolFee = (listing.price * $.protocolFeeBps) / 10_000;
        uint256 sellerProceeds = listing.price - protocolFee;

        _transfer(seller, msg.sender, tokenId);

        emit NameSold(tokenId, seller, msg.sender, listing.price);

        // Pay seller — don't revert if seller can't receive (anti-griefing)
        (bool ok,) = seller.call{value: sellerProceeds}("");
        if (!ok) emit SellerPaymentFailed(seller, sellerProceeds);

        uint256 excess = msg.value - listing.price;
        if (excess > 0) {
            (bool refundOk,) = msg.sender.call{value: excess}("");
            if (!refundOk) revert RefundFailed();
        }
    }

    // ── Marketplace: Offers ────────────────────────────────────────────────

    function makeOffer(uint256 tokenId, uint256 expiresAt) external payable nonReentrant {
        if (msg.value == 0) revert OfferAmountZero();
        if (expiresAt <= block.timestamp) revert OfferAlreadyExpired();
        ownerOf(tokenId); // reverts if token doesn't exist

        AttnNamesStorage storage $ = _s();

        // Refund existing offer from this buyer if any
        Offer memory existing = $.offers[tokenId][msg.sender];
        if (existing.amount > 0) {
            $.totalOfferEscrow -= existing.amount;
            delete $.offers[tokenId][msg.sender];
            (bool ok,) = msg.sender.call{value: existing.amount}("");
            if (!ok) revert RefundFailed();
        }

        $.offers[tokenId][msg.sender] = Offer({amount: msg.value, expiresAt: expiresAt});
        $.totalOfferEscrow += msg.value;
        emit OfferMade(tokenId, msg.sender, msg.value, expiresAt);
    }

    function cancelOffer(uint256 tokenId) external nonReentrant {
        AttnNamesStorage storage $ = _s();
        Offer memory offer = $.offers[tokenId][msg.sender];
        if (offer.amount == 0) revert NoOfferExists();

        $.totalOfferEscrow -= offer.amount;
        delete $.offers[tokenId][msg.sender];
        emit OfferCancelled(tokenId, msg.sender);

        (bool ok,) = msg.sender.call{value: offer.amount}("");
        if (!ok) revert RefundFailed();
    }

    function acceptOffer(uint256 tokenId, address buyer) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotNameOwner();

        AttnNamesStorage storage $ = _s();
        Offer memory offer = $.offers[tokenId][buyer];
        if (offer.amount == 0) revert NoOfferExists();
        if (block.timestamp >= offer.expiresAt) revert OfferExpired();

        // CEI: clear offer before external calls
        $.totalOfferEscrow -= offer.amount;
        delete $.offers[tokenId][buyer];

        uint256 protocolFee = (offer.amount * $.protocolFeeBps) / 10_000;
        uint256 sellerProceeds = offer.amount - protocolFee;

        _transfer(msg.sender, buyer, tokenId);

        emit OfferAccepted(tokenId, msg.sender, buyer, offer.amount);

        (bool ok,) = msg.sender.call{value: sellerProceeds}("");
        if (!ok) emit SellerPaymentFailed(msg.sender, sellerProceeds);
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function withdraw() external onlyOwner {
        AttnNamesStorage storage $ = _s();
        uint256 withdrawable = address(this).balance - $.totalOfferEscrow;
        if (withdrawable == 0) revert NothingToWithdraw();
        address recipient = owner();
        (bool ok,) = recipient.call{value: withdrawable}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(recipient, withdrawable);
    }

    function setRegistrationFee(uint256 newFee) external onlyOwner {
        AttnNamesStorage storage $ = _s();
        uint256 oldFee = $.registrationFee;
        $.registrationFee = newFee;
        emit RegistrationFeeUpdated(oldFee, newFee);
    }

    function setProtocolFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh();
        AttnNamesStorage storage $ = _s();
        uint256 oldBps = $.protocolFeeBps;
        $.protocolFeeBps = newBps;
        emit ProtocolFeeUpdated(oldBps, newBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Getters ────────────────────────────────────────────────────────────

    function registrationFee() external view returns (uint256) {
        return _s().registrationFee;
    }

    function protocolFeeBps() external view returns (uint256) {
        return _s().protocolFeeBps;
    }

    function totalRegistrations() external view returns (uint256) {
        return _s().totalRegistrations;
    }

    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return _s().listings[tokenId];
    }

    function getOffer(uint256 tokenId, address buyer) external view returns (Offer memory) {
        return _s().offers[tokenId][buyer];
    }

    function available(string calldata label) external view returns (bool) {
        bytes32 labelHash = keccak256(bytes(label));
        return _s().labelHashToNode[labelHash] == bytes32(0);
    }
}
