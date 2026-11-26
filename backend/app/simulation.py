import argparse
import json
import os
import re
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = {
    "normal": {
        "temperature": 28.0,
        "humidity": 55.0,
        "vibration_rate": 2.0,
        "current_rms": 0.4,
    },
    "warning": {
        "temperature": 66.0,
        "humidity": 90.0,
        "vibration_rate": 15.0,
        "current_rms": 4.0,
    },
    "critical": {
        "temperature": 80.0,
        "humidity": 98.0,
        "vibration_rate": 35.0,
        "current_rms": 6.0,
    },
}
CYCLE = ("normal", "warning", "critical", "normal", "normal")


def build_measurement(scenario: str, sequence: int, interval: float = 5.0) -> dict:
    if scenario == "cycle":
        scenario = CYCLE[(sequence - 1) % len(CYCLE)]
    values = SCENARIOS[scenario]
    return {
        "seq": sequence,
        "temperature": values["temperature"],
        "humidity": values["humidity"],
        "vibration_rate": values["vibration_rate"],
        "vibration_edges": round(values["vibration_rate"] * interval),
        "current_rms": values["current_rms"],
        "current_source": "simulated",
        "acquisition_mode": "simulated",
    }


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publie des mesures PrediMaint simulées via le broker MQTT local."
    )
    parser.add_argument("--machine-id", default="demo-machine")
    parser.add_argument("--scenario", choices=("normal", "critical", "cycle"), default="cycle")
    parser.add_argument("--interval", type=float, default=5.0, help="intervalle entre mesures, en secondes")
    parser.add_argument("--host", help="hôte MQTT (par défaut MQTT_SIMULATOR_HOST ou 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port MQTT (par défaut MQTT_HOST_PORT ou 1884)")
    return parser.parse_args()


def main() -> None:
    load_dotenv(PROJECT_ROOT / ".env")
    args = arguments()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.machine_id):
        raise SystemExit("machine-id invalide : utilisez des minuscules, chiffres, '_' ou '-'.")
    if args.interval <= 0:
        raise SystemExit("interval doit être supérieur à zéro.")

    username = os.getenv("MQTT_USERNAME", "")
    password = os.getenv("MQTT_PASSWORD", "")
    if not username or not password:
        raise SystemExit("Renseignez MQTT_USERNAME et MQTT_PASSWORD dans .env.")
    host = args.host or os.getenv("MQTT_SIMULATOR_HOST", "127.0.0.1")
    port = args.port or int(os.getenv("MQTT_HOST_PORT") or "1884")

    connected = threading.Event()
    connection_error: list[str] = []

    def on_connect(client, userdata, flags, reason_code, properties):
        code = getattr(reason_code, "value", reason_code)
        if code == 0:
            connected.set()
        else:
            connection_error.append(str(reason_code))
            connected.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=args.machine_id,
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(username, password)
    client.on_connect = on_connect

    loop_started = False
    try:
        client.connect(host, port, keepalive=30)
        client.loop_start()
        loop_started = True
        if not connected.wait(timeout=10):
            raise TimeoutError("Délai dépassé lors de la connexion au broker MQTT.")
        if connection_error:
            raise ConnectionError(f"Connexion MQTT refusée : {connection_error[0]}")

        print(
            f"Simulation {args.scenario} active pour {args.machine_id} via {host}:{port}. "
            "Ctrl+C pour arrêter.",
            flush=True,
        )
        sequence = 0
        while True:
            sequence += 1
            payload = build_measurement(args.scenario, sequence, args.interval)
            info = client.publish(
                f"predimaint/{args.machine_id}/telemetry",
                json.dumps(payload),
                qos=1,
            )
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                raise ConnectionError(f"Publication MQTT impossible : code {info.rc}")
            info.wait_for_publish(timeout=10)
            if not info.is_published():
                raise TimeoutError("Délai dépassé en attendant la confirmation MQTT.")
            print(f"Publié: {payload}", flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nSimulation arrêtée.", flush=True)
    finally:
        if client.is_connected():
            client.disconnect()
        if loop_started:
            client.loop_stop()


if __name__ == "__main__":
    main()
