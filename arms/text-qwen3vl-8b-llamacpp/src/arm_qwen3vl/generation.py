"""One job: validate it, stream it through the child, and report what came back.

The job is the studio's vocabulary (`prompt`, `images`, `maxTokens`), and this
module turns it into a chat completion request. The completion is streamed even
though the caller gets one answer at the end, because the stream is where the
timeline comes from: each chunk says whether the model is still thinking or has
started answering, and carries the child's running token count and rate.

The one path in a job is `images`: stills the model is shown alongside the last
user turn. They are named relative to the arm's input root, as the image and
video arms name their references, and nothing outside that root can be read.
They reach the child inline, as data URLs, because the child has no business
knowing where the studio keeps its files.
"""

from __future__ import annotations

import base64
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .progress import JobProgress
from .runtime import LlamaServer

MAX_PROMPT_CHARS = 2_000_000
MAX_MESSAGES = 256
MAX_TOKENS_CEILING = 262_144
ROLES = {"system", "user", "assistant"}
#: Nine is what H3's reference-to-video node takes; a few more leaves room for
#: a caller that is not this studio's video console.
MAX_IMAGES = 12
#: A still, not a video. Base64 makes it a third larger again in the request.
MAX_IMAGE_BYTES = 32 * 1024 * 1024
#: What the child is told each image is. The bytes decide what it actually
#: decodes; this only has to be a plausible type for the data URL.
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
}
# Per read, not per completion: a token that takes this long has stopped
# arriving, and a long answer is never cut off by it.
READ_TIMEOUT_SECONDS = 600.0


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass(frozen=True)
class Sampling:
    """The sampler settings a job actually ran with.

    The defaults are the Qwen3-VL Instruct model card's for vision-language
    work: temperature 0.7, top-p 0.8, top-k 20, presence penalty 1.5. A job may
    set any of them, and the report carries what was used, so silence is a
    documented choice rather than an accident.
    """

    temperature: float
    top_p: float
    top_k: int
    min_p: float
    presence_penalty: float
    repeat_penalty: float

    @staticmethod
    def default() -> Sampling:
        return Sampling(0.7, 0.8, 20, 0.0, 1.5, 1.0)


@dataclass
class Job:
    #: The chat as the child sees it. Content is a string, except the last
    #: user turn when there are images: then it is a list of parts.
    messages: list[dict[str, Any]]
    max_tokens: int
    thinking: bool
    sampling: Sampling
    seed: int
    reasoning_budget: int
    #: How the request was worded, for the record: the last user turn.
    prompt: str
    #: The images shown with the last user turn, relative to the input root.
    images: list[str] = field(default_factory=list)


@dataclass
class GenerationReport:
    text: str
    reasoning: str | None
    finish_reason: str
    model: str
    thinking: bool
    seed: int
    tokens_prompt: int
    tokens_cached: int
    tokens_generated: int
    #: Counted from the stream, one chunk per token, so this is exact for
    #: this build -- but it is a count of chunks that carried reasoning, not a
    #: figure the child reports.
    tokens_reasoning: int
    seconds_total: float
    seconds_prompt: float
    seconds_generate: float
    seconds_to_first_token: float
    prompt_tokens_per_second: float
    generate_tokens_per_second: float
    context_size: int
    peak_vram_gib: float
    #: What `peak_vram_gib` is a measurement *of*: "process", "card", or
    #: "unavailable". A whole-card peak filed as this arm's own would
    #: overstate it by whatever else was on the GPU.
    vram_scope: str
    sampling: dict[str, float]
    images: int = 0
    stages: list[dict[str, Any]] = field(default_factory=list)


def _int(body: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    number = int(value)
    if not low <= number <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return number


def _float(body: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    number = float(value)
    if not low <= number <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return number


def _bool(body: dict[str, Any], key: str, default: bool) -> bool:
    value = body.get(key, default)
    if not isinstance(value, bool):
        raise JobError(f"{key} must be true or false")
    return value


def _text(value: Any, what: str) -> str:
    if not isinstance(value, str):
        raise JobError(f"{what} must be a string")
    if "\x00" in value:
        raise JobError(f"{what} contains a null byte")
    if len(value) > MAX_PROMPT_CHARS:
        raise JobError(f"{what} is longer than {MAX_PROMPT_CHARS} characters")
    return value


def _inside(root: Path, candidate: Any, what: str) -> Path:
    """A job-supplied path, resolved and proven to be under `root`."""
    if not isinstance(candidate, str) or not candidate or "\x00" in candidate:
        raise JobError(f"{what} must be a path")
    if Path(candidate).is_absolute() or re.match(r"^[A-Za-z]:", candidate):
        raise JobError(f"{what} must be relative to the arm's input directory")

    resolved = (root / candidate).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise JobError(f"{what} resolves outside {root_resolved}")
    return resolved


def _images(body: dict[str, Any], in_dir: Path) -> list[Path]:
    raw = body.get("images", [])
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise JobError("images must be a list")
    if len(raw) > MAX_IMAGES:
        raise JobError(f"at most {MAX_IMAGES} images")

    found: list[Path] = []
    for index, entry in enumerate(raw):
        path = _inside(in_dir, entry, f"images[{index}]")
        if path.suffix.lower() not in IMAGE_TYPES:
            raise JobError(f"images[{index}] is not an image this arm reads ({', '.join(IMAGE_TYPES)})")
        if not path.is_file():
            raise JobError(f"images[{index}] ({entry}) is not there")
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise JobError(f"images[{index}] is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MiB")
        found.append(path)
    return found


def _data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{IMAGE_TYPES[path.suffix.lower()]};base64,{encoded}"


def parse_job(body: dict[str, Any], context_size: int, in_dir: Path) -> Job:
    """The studio's job, checked, as a chat.

    `messages` is the conversation so far; `prompt` is the turn being asked
    now and is appended as the last user message. Either may be absent, not
    both. `system` is a convenience for a single system message at the top.
    `images` are shown with the last user turn, in the order given -- which
    is the order the model will call them "the first image", "the second".
    """
    messages: list[dict[str, Any]] = []

    system = body.get("system")
    if system is not None and system != "":
        messages.append({"role": "system", "content": _text(system, "system")})

    history = body.get("messages", [])
    if not isinstance(history, list):
        raise JobError("messages must be a list")
    if len(history) > MAX_MESSAGES:
        raise JobError(f"messages must hold at most {MAX_MESSAGES} turns")
    for index, turn in enumerate(history):
        if not isinstance(turn, dict):
            raise JobError(f"messages[{index}] must be an object")
        role = turn.get("role")
        if role not in ROLES:
            raise JobError(f"messages[{index}].role must be one of {sorted(ROLES)}")
        messages.append(
            {"role": role, "content": _text(turn.get("content", ""), f"messages[{index}].content")}
        )

    prompt = body.get("prompt", "")
    prompt = _text(prompt, "prompt").strip() if prompt is not None else ""
    if prompt:
        messages.append({"role": "user", "content": prompt})
    elif not messages:
        raise JobError("prompt is required")
    elif messages[-1]["role"] != "user":
        raise JobError("the last message must be from the user when no prompt is given")

    if all(turn["role"] == "system" for turn in messages):
        raise JobError("prompt is required")

    images = _images(body, in_dir)
    # Read here rather than at request time, so a file that vanishes between
    # validation and sampling is a 400 about the file, not a 500 mid-stream.
    if images:
        last = messages[-1]
        last["content"] = [
            *({"type": "image_url", "image_url": {"url": _data_url(path)}} for path in images),
            {"type": "text", "text": last["content"]},
        ]

    # Off by default: the Instruct GGUF has no thought to give, and a Thinking
    # one dropped in its place should be asked before it spends tokens on one.
    thinking = _bool(body, "thinking", False)
    defaults = Sampling.default()
    sampling = Sampling(
        temperature=_float(body, "temperature", defaults.temperature, 0.0, 2.0),
        top_p=_float(body, "topP", defaults.top_p, 0.0, 1.0),
        top_k=_int(body, "topK", defaults.top_k, 0, 1000),
        min_p=_float(body, "minP", defaults.min_p, 0.0, 1.0),
        presence_penalty=_float(body, "presencePenalty", defaults.presence_penalty, -2.0, 2.0),
        repeat_penalty=_float(body, "repeatPenalty", defaults.repeat_penalty, 0.0, 2.0),
    )

    return Job(
        messages=messages,
        # Capped by the context rather than by a constant: a job cannot ask
        # for more tokens than the loaded child has room for.
        max_tokens=_int(body, "maxTokens", 8192, 1, min(context_size, MAX_TOKENS_CEILING)),
        thinking=thinking,
        sampling=sampling,
        seed=_int(body, "seed", -1, -1, 2**31 - 1),
        # -1 is unrestricted, the child's own default. 0 ends thinking at once,
        # which is a different thing from `thinking: false`: the template
        # still opens the thought, the child closes it immediately.
        reasoning_budget=_int(body, "reasoningBudget", -1, -1, MAX_TOKENS_CEILING),
        prompt=_last_user_text(messages),
        images=[path.relative_to(in_dir.resolve()).as_posix() for path in images],
    )


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for turn in reversed(messages):
        if turn["role"] != "user":
            continue
        content = turn["content"]
        if isinstance(content, str):
            return content
        return "".join(part.get("text", "") for part in content if part.get("type") == "text")
    return ""


def _request(job: Job) -> dict[str, Any]:
    body: dict[str, Any] = {
        "messages": job.messages,
        "max_tokens": job.max_tokens,
        "temperature": job.sampling.temperature,
        "top_p": job.sampling.top_p,
        "top_k": job.sampling.top_k,
        "min_p": job.sampling.min_p,
        "presence_penalty": job.sampling.presence_penalty,
        "repeat_penalty": job.sampling.repeat_penalty,
        "seed": job.seed,
        "stream": True,
        # Every chunk carries the child's running counts and rates; that is
        # what drives the token meter while the answer is still arriving.
        "timings_per_token": True,
        # The template's own switch. Off, the model answers without a thought
        # block at all, rather than emitting an empty one.
        "chat_template_kwargs": {"enable_thinking": job.thinking},
    }
    if job.reasoning_budget >= 0:
        body["reasoning_budget"] = job.reasoning_budget
    return body


def generate(server: LlamaServer, job: Job, progress: JobProgress) -> GenerationReport:
    started = time.perf_counter()
    stages: list[dict[str, Any]] = []
    reasoning: list[str] = []
    answer: list[str] = []
    reasoning_chunks = 0
    finish_reason = "unknown"
    model = ""
    timings: dict[str, Any] = {}
    first_token_at: float | None = None
    phase: str | None = None
    phase_started = started

    def close_phase(at: float) -> None:
        nonlocal phase
        if phase is None:
            return
        progress.finish_step(phase)
        stages.append({"name": phase, "seconds": round(at - phase_started, 3)})
        phase = None

    def open_phase(key: str, label: str, at: float) -> None:
        nonlocal phase, phase_started
        close_phase(at)
        phase = key
        phase_started = at
        progress.start(key, label, parent="generate")

    with progress.step(
        "generate",
        "Chat completion",
        f"{len(job.messages)} message(s)"
        + (f", {len(job.images)} image(s)" if job.images else "")
        + f", up to {job.max_tokens} tokens",
    ):
        # The prompt is being read until the first token says otherwise. Its
        # meter, for a long prompt, is driven by the child's log.
        open_phase("prompt", "Prompt processing", started)
        progress.meter("tokens", "Generated tokens", job.max_tokens)

        for event in server.stream("/v1/chat/completions", _request(job), READ_TIMEOUT_SECONDS):
            now = time.perf_counter()
            model = event.get("model", model) or model
            chunk_timings = event.get("timings")
            if isinstance(chunk_timings, dict):
                timings = chunk_timings
                predicted = int(timings.get("predicted_n", 0))
                rate = float(timings.get("predicted_per_second", 0.0))
                progress.meter(
                    "tokens", "Generated tokens", job.max_tokens, f"{rate:.1f} tok/s" if rate else None
                )
                progress.advance("tokens", predicted)
                # The child knows the prompt's exact length once it has read
                # it; the log's derived total gives way to that.
                prompt_n = int(timings.get("prompt_n", 0)) + int(timings.get("cache_n", 0))
                if prompt_n and phase == "prompt":
                    progress.meter("prompt", "Prompt tokens", prompt_n)
                    progress.advance("prompt", prompt_n, prompt_n)

            for choice in event.get("choices", []):
                delta = choice.get("delta") or {}
                thought = delta.get("reasoning_content")
                content = delta.get("content")
                if thought:
                    if first_token_at is None:
                        first_token_at = now
                    if phase != "think":
                        open_phase("think", "Think", now)
                    reasoning.append(thought)
                    reasoning_chunks += 1
                if content:
                    if first_token_at is None:
                        first_token_at = now
                    if phase != "answer":
                        open_phase("answer", "Answer", now)
                    answer.append(content)
                if choice.get("finish_reason"):
                    finish_reason = str(choice["finish_reason"])

        ended = time.perf_counter()
        close_phase(ended)

    prompt_ms = float(timings.get("prompt_ms", 0.0))
    predicted_ms = float(timings.get("predicted_ms", 0.0))
    text = "".join(answer)
    thought_text = "".join(reasoning)
    total = ended - started

    predicted_n = int(timings.get("predicted_n", 0))
    predicted_rate = float(timings.get("predicted_per_second", 0.0))
    prompt_n = int(timings.get("prompt_n", 0))
    prompt_rate = float(timings.get("prompt_per_second", 0.0))
    print(
        f"[arm] {finish_reason}: {predicted_n} tokens in {total:.1f}s ({predicted_rate:.1f} tok/s), "
        f"prompt {prompt_n} tokens at {prompt_rate:.0f} tok/s",
        flush=True,
    )

    return GenerationReport(
        text=text,
        reasoning=thought_text or None,
        finish_reason=finish_reason,
        model=model.replace("\\", "/").rsplit("/", 1)[-1],
        thinking=job.thinking,
        seed=job.seed,
        tokens_prompt=prompt_n,
        tokens_cached=int(timings.get("cache_n", 0)),
        tokens_generated=predicted_n,
        tokens_reasoning=reasoning_chunks,
        seconds_total=round(total, 3),
        seconds_prompt=round(prompt_ms / 1000.0, 3),
        seconds_generate=round(predicted_ms / 1000.0, 3),
        seconds_to_first_token=round((first_token_at or ended) - started, 3),
        prompt_tokens_per_second=round(prompt_rate, 1),
        generate_tokens_per_second=round(predicted_rate, 1),
        context_size=server.config.context_size,
        peak_vram_gib=round(progress.peak_gib, 3),
        vram_scope="unavailable",
        sampling={
            "temperature": job.sampling.temperature,
            "top_p": job.sampling.top_p,
            "top_k": job.sampling.top_k,
            "min_p": job.sampling.min_p,
            "presence_penalty": job.sampling.presence_penalty,
            "repeat_penalty": job.sampling.repeat_penalty,
        },
        images=len(job.images),
        stages=stages,
    )
