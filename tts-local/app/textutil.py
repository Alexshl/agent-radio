import re


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def split_sentences(text: str, max_len: int = 220) -> list[str]:
    """Sentence-sized chunks (the models degrade on long input)."""
    text = clean(text)
    parts = re.split(r"(?<=[.!?…])\s+", text)
    out: list[str] = []
    for p in parts:
        while len(p) > max_len:
            cut = p.rfind(",", 0, max_len)
            cut = cut if cut > 40 else p.rfind(" ", 0, max_len)
            cut = cut if cut > 0 else max_len
            out.append(p[: cut + 1].strip())
            p = p[cut + 1 :].strip()
        if p:
            out.append(p)
    # glue very short fragments to the next sentence ("Привіт!")
    merged: list[str] = []
    for p in out:
        if merged and len(merged[-1]) < 12:
            merged[-1] = f"{merged[-1]} {p}"
        else:
            merged.append(p)
    return merged
