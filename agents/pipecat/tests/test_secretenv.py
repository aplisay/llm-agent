"""Wire-compatibility tests for the secretenv loader.

The fixture below was produced by the real Node package
(github.com/rjp44/secretenv) so these tests fail if the Python decryption ever
diverges from it:

    SECRETENV_KEY=go-vector-key
    printf 'OPENAI_API_KEY=sk-test-12345\\n'\\
           'PIPECAT_SIP_PASSWORD=p@ss:word/with+specials==\\n'\\
           'SIPBRIDGE_API_TOKEN=deadbeefcafebabe\\n' > .env
    SECRETENV_KEY=go-vector-key npx secretenv -e
"""

from __future__ import annotations

import os

import pytest

from pipecat_aplisay import secretenv

VECTOR_KEY = "go-vector-key"
VECTOR_BUNDLE = (
    "d1b3386ae4ed260a7a4265583f91196b:"
    "cEsHs85c4Ym3lmxRxxXgv+7sW452MU/4kZ9GbNcCFeuOMfqPKG1jBWIMvCFV54EYfi4xKnah"
    "qFqWTg5ahtjv5C3xKuJAr+BiYJxhDy8NnC/vfryJqXzej5gpBd/1og2eufojyHsK88fFJUiW"
    "dX1kpk+EolJOV5NOBJkaPFRAbm0="
)
VECTOR_WANT = {
    "OPENAI_API_KEY": "sk-test-12345",
    # colons here must NOT confuse the iv:ciphertext split
    "PIPECAT_SIP_PASSWORD": "p@ss:word/with+specials==",
    "SIPBRIDGE_API_TOKEN": "deadbeefcafebabe",
}


def test_decrypt_matches_node():
    assert secretenv._decrypt(VECTOR_BUNDLE, VECTOR_KEY) == VECTOR_WANT


def test_decrypt_wrong_key_raises():
    with pytest.raises(Exception):
        secretenv._decrypt(VECTOR_BUNDLE, "not-the-key")


@pytest.fixture
def clean_env(monkeypatch):
    for var in (*VECTOR_WANT, "SECRETENV_KEY", "SECRETENV_BUNDLE", "GOOGLE_SECRETENV_PATH"):
        monkeypatch.delenv(var, raising=False)


def test_load_sets_environment(clean_env, monkeypatch):
    monkeypatch.setenv("SECRETENV_KEY", VECTOR_KEY)
    monkeypatch.setenv("SECRETENV_BUNDLE", VECTOR_BUNDLE)
    secretenv.load()
    for k, v in VECTOR_WANT.items():
        assert os.environ[k] == v


def test_load_noop_when_unset(clean_env):
    secretenv.load()  # must not raise
    assert "OPENAI_API_KEY" not in os.environ


def test_load_bad_bundle_is_logged_not_raised(clean_env, monkeypatch):
    monkeypatch.setenv("SECRETENV_KEY", VECTOR_KEY)
    monkeypatch.setenv("SECRETENV_BUNDLE", "not-a-valid-bundle")
    secretenv.load()  # swallows the error
    assert "OPENAI_API_KEY" not in os.environ


GOOGLE_VARS = (
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CREDENTIAL",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
)


@pytest.fixture
def clean_google_env(monkeypatch):
    for var in GOOGLE_VARS:
        monkeypatch.delenv(var, raising=False)


def test_materialise_google_credential_writes_file(clean_google_env, monkeypatch, tmp_path):
    dest = tmp_path / "credentials" / "google.json"
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(dest))
    monkeypatch.setenv("GOOGLE_CREDENTIAL", '{"type":"service_account"}')

    secretenv._materialise_google_credential()

    assert dest.read_text(encoding="utf-8") == '{"type":"service_account"}'
    # holds a private key → owner-only
    assert oct(dest.stat().st_mode & 0o777) == "0o600"


def test_materialise_google_credential_does_not_clobber_existing(clean_google_env, monkeypatch, tmp_path):
    dest = tmp_path / "google.json"
    dest.write_text("MOUNTED", encoding="utf-8")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(dest))
    monkeypatch.setenv("GOOGLE_CREDENTIAL", '{"type":"service_account"}')

    secretenv._materialise_google_credential()

    assert dest.read_text(encoding="utf-8") == "MOUNTED"


def test_materialise_google_credential_noop_without_content(clean_google_env, monkeypatch, tmp_path):
    dest = tmp_path / "google.json"
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(dest))

    secretenv._materialise_google_credential()  # no GOOGLE_CREDENTIAL set

    assert not dest.exists()


def test_materialise_google_credential_noop_without_path(clean_google_env, monkeypatch):
    monkeypatch.setenv("GOOGLE_CREDENTIAL", '{"type":"service_account"}')
    # must not raise when GOOGLE_APPLICATION_CREDENTIALS is unset
    secretenv._materialise_google_credential()


def test_materialise_google_credential_json_fallback(clean_google_env, monkeypatch, tmp_path):
    dest = tmp_path / "google.json"
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(dest))
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", '{"from":"json"}')

    secretenv._materialise_google_credential()

    assert dest.read_text(encoding="utf-8") == '{"from":"json"}'
