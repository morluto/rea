# Voice MIDI prototype

This is an independent, minimal microphone-to-MIDI example. It does not copy
or patch Dubler, use Vochlea assets, or require an account, login, or
registration.

The prototype accepts monophonic audio, estimates its fundamental frequency
with normalized autocorrelation, and emits MIDI note-on/note-off messages.
It is intentionally smaller than a production vocal instrument: it does not
implement drum classification, scales, effects, presets, or hardware control.

## Setup

```powershell
python -m pip install numpy sounddevice mido python-rtmidi
```

List available devices and MIDI ports:

```powershell
python -c "import sounddevice as sd, mido; print(sd.query_devices()); print(mido.get_output_names())"
```

Run it:

```powershell
python examples\voice-midi\voice_to_midi.py --midi-port "Your MIDI Port"
```

The program is local-only and sends MIDI to the selected output. Press
`Ctrl+C` to stop.
