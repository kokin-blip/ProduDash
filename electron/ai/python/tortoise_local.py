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
    parser.add_argument("--reference-path", required=True)
    parser.add_argument("--preset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    socket.create_connection = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network

    import torchaudio
    from tortoise.api import TextToSpeech
    from tortoise.utils.audio import load_audio

    model = TextToSpeech()
    if args.validate:
        write_probe(args.output)
        return
    text = sys.stdin.read(4097)
    if not text or len(text) > 4096:
        raise RuntimeError("Voiceover text is outside the supported bounds.")
    reference = load_audio(args.reference_path, 22050)
    audio = model.tts_with_preset(text, voice_samples=[reference], preset=args.preset)
    waveform = audio.squeeze(0).cpu()
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    torchaudio.save(args.output, waveform, 24000)


if __name__ == "__main__":
    main()
