import argparse
import socket
import sys
import wave


def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network access is disabled for this local ProduDash runtime.")


def write_probe(output_path):
    with wave.open(output_path, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * 1600)


def load_model(variant, device):
    if variant in ("nano", "turbo"):
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        return ChatterboxTurboTTS.from_pretrained(device=device, nano=variant == "nano")
    if variant == "multilingual-v3":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        return ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
    from chatterbox.tts import ChatterboxTTS

    return ChatterboxTTS.from_pretrained(device=device)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-path", required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    socket.create_connection = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network

    import torchaudio

    model = load_model(args.variant, args.device)
    if args.validate:
        write_probe(args.output)
        return
    text = sys.stdin.read(4097)
    if not text or len(text) > 4096:
        raise RuntimeError("Voiceover text is outside the supported bounds.")
    if args.variant == "multilingual-v3":
        audio = model.generate(text, language_id=args.language, audio_prompt_path=args.reference_path)
    else:
        audio = model.generate(text, audio_prompt_path=args.reference_path)
    torchaudio.save(args.output, audio, model.sr)


if __name__ == "__main__":
    main()
