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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--config-path", required=True)
    parser.add_argument("--reference-path")
    parser.add_argument("--language")
    parser.add_argument("--output", required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    socket.create_connection = deny_network
    original_connect = socket.socket.connect
    socket.socket.connect = deny_network
    try:
        from TTS.api import TTS

        model = TTS(model_path=args.model_path, config_path=args.config_path, progress_bar=False)
        if args.validate:
            write_probe(args.output)
            return
        if not args.reference_path or not args.language:
            raise RuntimeError("Reference audio and language are required.")
        text = sys.stdin.read(4097)
        if not text or len(text) > 4096:
            raise RuntimeError("Voiceover text is outside the supported bounds.")
        model.tts_to_file(
            text=text,
            speaker_wav=[args.reference_path],
            language=args.language,
            file_path=args.output,
            split_sentences=True,
        )
    finally:
        socket.socket.connect = original_connect


if __name__ == "__main__":
    main()
