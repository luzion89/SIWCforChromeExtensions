"""Build the embeddable SDK and the unpacked Chrome demo using Python 3."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist"
VERSION = json.loads((ROOT / "demo/manifest.json").read_text())["version"]


def package(name, directories):
    destination = OUT / f"siwc-{name}-{VERSION}.zip"
    with TemporaryDirectory(dir=OUT) as temp:
        archive = Path(temp) / destination.name
        with ZipFile(archive, "w", ZIP_DEFLATED) as bundle:
            for source, prefix in directories:
                for entry in sorted(source.iterdir()):
                    if entry.is_file() and not entry.name.startswith("."):
                        bundle.write(entry, prefix / entry.name)
        archive.replace(destination)
    print(destination.relative_to(ROOT))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    sdk = (ROOT / "siwc", Path("siwc"))
    package("sdk", [sdk])
    package("demo", [(ROOT / "demo", Path(".")), sdk])
