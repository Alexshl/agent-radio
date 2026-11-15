"""TTS engines of the sidecar. Every engine loads lazily in a background thread (the first start downloads the models into /models) and
synthesizes one request at a time. synthesize() returns (mono float32 samples, sample rate, rate_applied_natively)."""
import os
import re
import threading
import time
from pathlib import Path

import numpy as np

from .textutil import clean, split_sentences

MODELS = Path(os.environ.get("MODELS_DIR", "/models"))
REF_DIR = Path(os.environ.get("REF_DIR", Path(__file__).resolve().parent.parent / "ref"))


class Engine:
    id = ""
    label = ""
    lang = ""
    license = ""
    native_rate = False

    def __init__(self) -> None:
        self.status = "idle"  # idle | loading | ready | error
        self.error = ""
        self.loaded_at = 0.0
        self._lock = threading.Lock()

    def voices(self) -> list[dict]:
        return []

    def _load(self) -> None:
        raise NotImplementedError

    def load(self) -> None:
        if self.status in ("loading", "ready"):
            return
        self.status, self.error = "loading", ""
        try:
            self._load()
            self.status, self.loaded_at = "ready", time.time()
        except Exception as e:  # noqa: BLE001 - reported through /voices
            self.status, self.error = "error", f"{type(e).__name__}: {e}"
            print(f"engine {self.id} failed to load: {self.error}", flush=True)

    def synthesize(self, voice: str, text: str, rate: float) -> tuple[np.ndarray, int, bool]:
        raise NotImplementedError

    def info(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "lang": self.lang,
            "license": self.license,
            "status": self.status,
            "error": self.error,
            "nativeRate": self.native_rate,
            "voices": self.voices() if self.status == "ready" else [],
        }


def _pause(sr: int, sec: float = 0.18) -> np.ndarray:
    return np.zeros(int(sr * sec), dtype=np.float32)


# ---------------------------------------------------------------- StyleTTS2 Ukrainian (patriotyk, MIT)
SPEAKERS_UK = [
    "Інна Гелевера", "Анастасія Павленко", "Артем Окороков", "Вʼячеслав Дудко", "Вероніка Дорош", "Влада Муравець",
    "Вікторія Левченко", "Гаська Шиян", "Денис Денисенко", "Катерина Потапенко", "Кирило Татарченко", "Людмила Чиркова",
    "Марина Панас", "Марися Нікітюк", "Марта Мольфар", "Марічка Штирбулова", "Матвій Ніколаєв", "Михайло Тишин",
    "Олександр Ролдугін", "Олена Шверк", "Павло Буковський", "Петро Філяк", "Поліна Еккерт(хлопчик)", "Поліна Еккерт",
    "Роман Куліш", "Слава Красовська", "Тарас Василюк", "Тетяна Гончарова", "Тетяна Лукинюк", "Юрій Вихованець", "Юрій Кудрявець",
]  # fmt: skip


class StyleTts2Uk(Engine):
    id = "styletts2"
    label = "StyleTTS2 Ukrainian"
    lang = "uk"
    license = "MIT (patriotyk/styletts2-ukrainian, ukrainian-word-stress, ipa-uk)"
    native_rate = True

    def voices(self) -> list[dict]:
        return [{"id": n, "label": n, "lang": "uk"} for n in SPEAKERS_UK]

    def _load(self) -> None:
        import stanza
        import torch
        from huggingface_hub import hf_hub_download
        from ipa_uk import ipa
        from styletts2_inference.models import StyleTTS2
        from ukrainian_word_stress import Stressifier

        torch.set_num_threads(int(os.environ.get("TTS_LOCAL_THREADS", "6")))
        res = os.environ.get("STANZA_RESOURCES_DIR", str(MODELS / "stanza"))
        stanza.download("uk", model_dir=res, processors="tokenize,pos,mwt", logging_level="WARNING")
        self._stress = Stressifier()
        self._ipa = ipa
        self._model = StyleTTS2(hf_path="patriotyk/styletts2_ukrainian_multispeaker_hifigan", device="cpu")
        self._model.eval()
        self._styles: dict[str, "torch.Tensor"] = {}
        for n in SPEAKERS_UK:
            p = hf_hub_download(repo_id="patriotyk/styletts2-ukrainian", repo_type="space", filename=f"voices/{n}.pt")
            # style vectors are pickled numpy arrays from the model author's Space (trusted source, pinned repo)
            self._styles[n] = torch.load(p, map_location="cpu", weights_only=False)

    def synthesize(self, voice: str, text: str, rate: float):
        import torch
        from unicodedata import normalize

        from ukrainian_word_stress import StressSymbol

        style = self._styles[voice] if voice in self._styles else self._styles["Денис Денисенко"]
        chunks = []
        with torch.inference_mode():
            for part in split_sentences(text):
                t = normalize("NFKC", part.replace('"', "").replace("+", StressSymbol.CombiningAcuteAccent))
                t = re.sub(r"[᠆‐‑‒–—―⁻₋−⸺⸻]", "-", t)
                t = re.sub(r" - ", ": ", t)
                if not t.strip():
                    continue
                if t[-1] not in ".?!:-":
                    t += "."
                ps = self._ipa(self._stress(t))
                if not ps:
                    continue
                tokens = self._model.tokenizer.encode(ps)
                wav = self._model(tokens, speed=rate, s_prev=style)
                chunks += [wav.cpu().numpy().astype(np.float32), _pause(24000)]
        if not chunks:
            raise ValueError("nothing to say")
        return np.concatenate(chunks[:-1]), 24000, True


# ---------------------------------------------------------------- Silero v5 Russian (CC BY-NC-SA 4.0)
class SileroRu(Engine):
    id = "silero"
    label = "Silero v5 Russian"
    lang = "ru"
    license = "CC BY-NC-SA 4.0 (snakers4/silero-models): non-commercial use only"
    URL = "https://models.silero.ai/models/tts/ru/v5_ru.pt"
    SPEAKERS = ["aidar", "baya", "kseniya", "xenia", "eugene"]

    def voices(self) -> list[dict]:
        return [{"id": s, "label": s.capitalize(), "lang": "ru"} for s in self.SPEAKERS]

    def _load(self) -> None:
        import torch

        torch.set_num_threads(int(os.environ.get("TTS_LOCAL_THREADS", "6")))
        path = MODELS / "silero" / "v5_ru.pt"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            torch.hub.download_url_to_file(self.URL, str(path) + ".part", progress=False)
            os.replace(str(path) + ".part", path)
        self._model = torch.package.PackageImporter(str(path)).load_pickle("tts_models", "model")
        self._model.to("cpu")

    def synthesize(self, voice: str, text: str, rate: float):
        import torch

        speaker = voice if voice in self.SPEAKERS else "xenia"
        chunks = []
        with torch.inference_mode():
            for part in split_sentences(text, 600):
                audio = self._model.apply_tts(
                    text=part, speaker=speaker, sample_rate=48000, put_accent=True, put_yo=True, put_stress_homo=True, put_yo_homo=True
                )
                chunks += [audio.cpu().numpy().astype(np.float32), _pause(48000)]
        if not chunks:
            raise ValueError("nothing to say")
        return np.concatenate(chunks[:-1]), 48000, False


# ---------------------------------------------------------------- F5-TTS Russian (ESpeech, Apache-2.0), experimental
class F5Ru(Engine):
    id = "f5"
    label = "F5-TTS Russian (ESpeech, experimental)"
    lang = "ru"
    license = "Apache-2.0 (ESpeech/ESpeech-TTS-1_RL-V2, F5-TTS code MIT, reference clip from ESpeech-webinars2 Apache-2.0)"
    native_rate = True
    REPO = "ESpeech/ESpeech-TTS-1_RL-V2"

    def voices(self) -> list[dict]:
        return [{"id": "ref", "label": "Референсный голос", "lang": "ru"}]

    def _load(self) -> None:
        import torch
        from f5_tts.infer.utils_infer import load_model, load_vocoder
        from f5_tts.model import DiT
        from huggingface_hub import hf_hub_download
        from ruaccent import RUAccent

        torch.set_num_threads(int(os.environ.get("TTS_LOCAL_THREADS", "6")))
        cfg = dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4)
        ckpt = hf_hub_download(self.REPO, "espeech_tts_rlv2.pt")
        vocab = hf_hub_download(self.REPO, "vocab.txt")
        self._model = load_model(DiT, cfg, ckpt, vocab_file=vocab, device="cpu")
        self._vocoder = load_vocoder(device="cpu")
        # the dictionaries and nets go to the models volume; its small `koziev` helper package is installed into site-packages (writable, see Dockerfile)
        self._acc = RUAccent()
        self._acc.load(omograph_model_size="turbo3.1", use_dictionary=True, tiny_mode=False, workdir=str(MODELS / "ruaccent"))
        self._ref_text = self._accent((REF_DIR / "ru.txt").read_text(encoding="utf-8").strip())

    def _accent(self, text: str) -> str:
        return text if "+" in text else self._acc.process_all(text)

    def synthesize(self, voice: str, text: str, rate: float):
        from f5_tts.infer.utils_infer import infer_process, preprocess_ref_audio_text

        ref_audio, ref_text = preprocess_ref_audio_text(str(REF_DIR / "ru.wav"), self._ref_text, show_info=lambda *_: None)
        gen = self._accent(clean(text))
        wav, sr, _ = infer_process(
            ref_audio, ref_text, gen, self._model, self._vocoder, speed=rate, nfe_step=int(os.environ.get("TTS_LOCAL_F5_STEPS", "16")), show_info=lambda *_: None, progress=None
        )
        return np.asarray(wav, dtype=np.float32), int(sr), True


def build_engines() -> dict[str, Engine]:
    enabled = {e.strip() for e in os.environ.get("TTS_LOCAL_ENGINES", "styletts2").split(",") if e.strip()}
    if os.environ.get("TTS_LOCAL_F5") == "1":
        enabled.add("f5")
    all_engines: list[Engine] = [StyleTts2Uk(), SileroRu(), F5Ru()]
    return {e.id: e for e in all_engines if e.id in enabled}
