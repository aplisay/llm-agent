"""Neuphonic TTS with the language code Neuphonic expects. See docs/neuphonic.md."""

from __future__ import annotations

from pipecat.services.neuphonic.tts import NeuphonicTTSService
from pipecat.transcriptions.language import Language


class AplisayNeuphonicTTSService(NeuphonicTTSService):
    def language_to_service_language(self, language: Language) -> str | None:
        # Neuphonic takes lowercase base codes. Pipecat 1.10 maps Language.HI to "HI", which
        # Neuphonic accepts but does not speak as Hindi, and warns on every regional tag.
        return str(language.value).split("-")[0].lower()
