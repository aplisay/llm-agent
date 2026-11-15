"""Make a self-signed TLS key pair for a SIP listener.

    python -m pipecat_aplisay.selfsigned <directory>

Writes ``tls.crt`` and ``tls.key`` there. For a gateway that will not start
its TLS listener without a certificate and cannot make one itself. Use a
CA-signed pair where the far end checks the certificate.
"""

from __future__ import annotations

import datetime
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

VALID_DAYS = 3650


def make(directory: str, common_name: str = "pipecat-sip") -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(common_name)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, "tls.crt"), "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    key_path = os.path.join(directory, "tls.key")
    with open(key_path, "wb") as f:
        f.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    # The gateway may run as another user of the same pod.
    os.chmod(key_path, 0o644)


if __name__ == "__main__":
    make(sys.argv[1] if len(sys.argv) > 1 else ".")
