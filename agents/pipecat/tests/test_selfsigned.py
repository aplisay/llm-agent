"""The self-signed TLS pair made for a SIP listener that needs a certificate."""

from __future__ import annotations

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from pipecat_aplisay import selfsigned


def test_the_pair_is_a_key_and_its_certificate(tmp_path):
    selfsigned.make(str(tmp_path))
    cert = x509.load_pem_x509_certificate((tmp_path / "tls.crt").read_bytes())
    key = serialization.load_pem_private_key((tmp_path / "tls.key").read_bytes(), password=None)
    public = serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    assert cert.public_key().public_bytes(*public) == key.public_key().public_bytes(*public)
    assert (cert.not_valid_after_utc - cert.not_valid_before_utc).days >= selfsigned.VALID_DAYS
