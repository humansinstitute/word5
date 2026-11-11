package ai.otherstuff.word5

/** NIP-19 public npub only. No secret or arbitrary identifier import path. */
fun amberPublicKey(value: String): String {
    if(value.matches(Regex("[0-9a-fA-F]{64}"))) return value.lowercase()
    require(value.startsWith("npub1") && value == value.lowercase() && value.length == 63) { "Invalid Amber public account" }
    val alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    val data = value.substring(5).map { alphabet.indexOf(it).also { n -> require(n >= 0) } }
    var checksum = 1
    val expanded = "npub".map { it.code shr 5 } + 0 + "npub".map { it.code and 31 } + data
    val generators = intArrayOf(0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3)
    expanded.forEach { v -> val top = checksum ushr 25; checksum = ((checksum and 0x1ffffff) shl 5) xor v; (0..4).forEach { i -> if((top ushr i) and 1 != 0) checksum = checksum xor generators[i] } }
    require(checksum == 1)
    var buffer = 0; var bits = 0; val result = ArrayList<Byte>()
    data.dropLast(6).forEach { v -> buffer = (buffer shl 5) or v; bits += 5; while(bits >= 8) { bits -= 8; result.add((buffer ushr bits).toByte()) } }
    require(result.size == 32 && bits < 5 && ((buffer shl (8 - bits)) and 255) == 0)
    return result.joinToString("") { "%02x".format(it) }
}
