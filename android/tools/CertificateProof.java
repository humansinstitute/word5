import java.nio.file.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.Base64;

/** Public C1 proof output only; app signing key remains in its external keystore. */
class CertificateProof {
    public static void main(String[] args) throws Exception {
        if (args.length != 3 || !args[0].matches("[0-9a-f]{64}")) throw new IllegalArgumentException("owner-hex created-at expiry required");
        long created = Long.parseLong(args[1]), expiry = Long.parseLong(args[2]);
        if (expiry <= created || expiry - created > 2L * 365 * 86400) throw new IllegalArgumentException("Invalid proof interval");
        KeyStore store = KeyStore.getInstance("PKCS12");
        char[] password = System.getenv("WORD5_STORE_PASSWORD").toCharArray();
        try (var in = Files.newInputStream(Path.of(System.getenv("WORD5_KEYSTORE")))) { store.load(in, password); }
        PrivateKey key = (PrivateKey) store.getKey("word5", System.getenv("WORD5_KEY_PASSWORD").toCharArray());
        var certificate = (X509Certificate) store.getCertificate("word5");
        String text = "Verifying at " + created + " until " + expiry + " that I control the following Nostr public key: " + args[0];
        Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(key); signer.update(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String signature = Base64.getEncoder().encodeToString(signer.sign());
        String der = Base64.getEncoder().encodeToString(certificate.getEncoded());
        String hash = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
        System.out.println("{\"certificate_der\":\"" + der + "\",\"certificate_sha256\":\"" + hash + "\",\"ownership_proof\":{\"owner\":\"" + args[0] + "\",\"created_at\":" + created + ",\"expiry\":" + expiry + ",\"signature\":\"" + signature + "\"}}");
        java.util.Arrays.fill(password, '\0');
    }
}
