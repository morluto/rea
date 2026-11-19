"""Regenerate with aioquic==1.5.0: python produce.py [--check].

Drive the pinned packet-recovery/logger implementations entirely in memory.
No sockets, network loss, target program or QUIC peer is involved. Fixed time
keeps the complete producer trace (including metrics) reproducible. The private
loss callback is deliberate: this fixture pins that version's emitted format,
not its timer-based loss detection or network behavior. Install the producer
in a separate environment with `python -m pip install aioquic==1.5.0`.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import aioquic
from aioquic.quic.logger import QuicLogger
from aioquic.quic.packet import QuicPacketType
from aioquic.quic.packet_builder import QuicSentPacket
from aioquic.quic.recovery import QuicPacketRecovery, QuicPacketSpace
from aioquic.tls import Epoch

if aioquic.__version__ != "1.5.0":
    raise SystemExit("This recorded producer requires aioquic 1.5.0.")

logger = QuicLogger()
for is_client in (True, False):
    trace = logger.start_trace(is_client=is_client, odcid=b"\x01\x02\x03\x04")
    recovery = QuicPacketRecovery(
        congestion_control_algorithm="reno",
        initial_rtt=0.1,
        max_datagram_size=1280,
        peer_completed_address_validation=True,
        send_probe=lambda: None,
        quic_logger=trace,
    )
    # Initial, Handshake and Application are separate number spaces. 0-RTT
    # and 1-RTT share Application; servers never send 0-RTT packets.
    spaces = {
        name: QuicPacketSpace()
        for name in ("initial", "handshake", "application")
    }
    packets = [
        (Epoch.INITIAL, QuicPacketType.INITIAL, "initial", 7),
        (Epoch.HANDSHAKE, QuicPacketType.HANDSHAKE, "handshake", 7),
    ]
    if is_client:
        packets.append((Epoch.ZERO_RTT, QuicPacketType.ZERO_RTT, "application", 7))
    packets.append(
        (Epoch.ONE_RTT, QuicPacketType.ONE_RTT, "application", 8 if is_client else 7)
    )
    with patch("aioquic.quic.logger.time.time", return_value=1700000000.25):
        for epoch, packet_type, space_name, number in packets:
            packet = QuicSentPacket(
                epoch=epoch,
                in_flight=True,
                is_ack_eliciting=True,
                is_crypto_packet=epoch in (Epoch.INITIAL, Epoch.HANDSHAKE),
                packet_number=number,
                packet_type=packet_type,
                sent_time=1.0,
                sent_bytes=1200,
            )
            space = spaces[space_name]
            recovery.on_packet_sent(packet=packet, space=space)
            recovery._on_packets_lost(now=2.0, packets=[packet], space=space)

text = json.dumps(logger.to_dict(), indent=2) + "\n"
path = Path(__file__).with_name("recovery.qlog")
if sys.argv[1:] == ["--check"]:
    if path.read_text() != text:
        raise SystemExit("Recorded qlog differs from the pinned producer")
    print("aioquic recovery output matches: two traces, seven loss declarations.")
elif not sys.argv[1:]:
    path.write_text(text)
else:
    raise SystemExit("Usage: produce.py [--check]")
