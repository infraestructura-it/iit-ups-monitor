#!/usr/bin/env python3
"""Puente GPIO para Raspberry Pi 5 usando lgpio (preinstalado en Raspberry Pi OS Bookworm).
Protocolo: una línea JSON por petición en stdin, una línea JSON por respuesta/evento en stdout.
Mientras este proceso viva, las salidas mantienen su estado."""
import json, sys, threading, time
import lgpio

lock = threading.Lock()
inputs = {}          # gpio -> último nivel
POLL_S = float(sys.argv[1]) if len(sys.argv) > 1 else 0.05


def send(obj):
    with lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def open_chip():
    # Pi 5: el conector está en el RP1 (gpiochip0 en kernels recientes, gpiochip4 en antiguos)
    last = None
    for n in (0, 4, 1, 2, 3):
        try:
            h = lgpio.gpiochip_open(n)
        except Exception as e:
            last = e
            continue
        try:
            info = lgpio.gpio_get_chip_info(h)
            label = str(info[-1]).lower()
            if "rp1" in label or "pinctrl" in label:
                return h, n, label
        except Exception:
            pass
        lgpio.gpiochip_close(h)
    raise RuntimeError(f"No se encontró el gpiochip del RP1 ({last})")


h, chip, label = open_chip()
send({"event": "ready", "chip": chip, "label": label})

PULL = {"up": lgpio.SET_PULL_UP, "down": lgpio.SET_PULL_DOWN, "none": lgpio.SET_PULL_NONE}


def poll():
    while True:
        for g in list(inputs.keys()):
            try:
                v = lgpio.gpio_read(h, g)
            except Exception:
                continue
            if v != inputs.get(g):
                inputs[g] = v
                send({"event": "input", "gpio": g, "level": v})
        time.sleep(POLL_S)


threading.Thread(target=poll, daemon=True).start()

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid, op = req.get("id"), req.get("op")
    try:
        g = req.get("gpio")
        if op == "output":
            inputs.pop(g, None)
            try: lgpio.gpio_free(h, g)
            except Exception: pass
            lgpio.gpio_claim_output(h, g, int(req.get("level", 0)))
            send({"id": rid, "ok": True})
        elif op == "input":
            try: lgpio.gpio_free(h, g)
            except Exception: pass
            lgpio.gpio_claim_input(h, g, PULL.get(req.get("pull", "none"), lgpio.SET_PULL_NONE))
            inputs[g] = lgpio.gpio_read(h, g)
            send({"id": rid, "ok": True, "value": inputs[g]})
        elif op == "write":
            lgpio.gpio_write(h, g, int(req["level"]))
            send({"id": rid, "ok": True})
        elif op == "read":
            send({"id": rid, "ok": True, "value": lgpio.gpio_read(h, g)})
        elif op == "free":
            inputs.pop(g, None)
            lgpio.gpio_free(h, g)
            send({"id": rid, "ok": True})
        else:
            send({"id": rid, "ok": False, "error": f"operación desconocida {op}"})
    except Exception as e:
        send({"id": rid, "ok": False, "error": str(e)})
