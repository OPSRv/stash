# PyInstaller spec for stash-separator.
#
# Produces a `--onedir`-style bundle under `dist/stash-separator/` so each
# shared library can be code-signed individually for macOS notarization
# (Apple rejects the self-extracting `--onefile` form on stricter hardened
# runtimes; --onedir keeps every dylib visible to `codesign --deep`).
#
# Build with: pyinstaller --noconfirm --clean stash-separator.spec

# ruff: noqa: F821 — Analysis/PYZ/EXE/COLLECT are PyInstaller-injected globals

block_cipher = None

a = Analysis(
    ["src/main.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        "demucs",
        "demucs.api",
        "demucs.htdemucs",
        "demucs.transformer",
        "demucs.pretrained",
        "BeatNet",
        "BeatNet.BeatNet",
        "torch",
        "torchaudio",
        "soundfile",
        "numpy",
        "scipy",
        "scipy.signal",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "matplotlib",
        "tkinter",
        "PIL",
        "IPython",
        "jupyter",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="stash-separator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="stash-separator",
)
