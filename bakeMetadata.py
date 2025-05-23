#!/usr/bin/env python3
import sys
import os
import json
import eyed3
import mimetypes
import argparse
import logging
from eyed3.id3 import ID3_V2_4
from PyQt5 import QtWidgets, QtCore

# Custom logging handler to forward logs to the GUI status window.
class GuiLogHandler(logging.Handler):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def emit(self, record):
        try:
            msg = self.format(record)
            self.callback(msg)
        except Exception:
            self.handleError(record)

def bake_metadata(workingDir, progress_callback=None):
    if workingDir.startswith("'"):
        workingDir = workingDir[1:-1]
    # Sort the working list alphabetically
    workingList = sorted(os.listdir(workingDir))

    if "metadata" not in workingList:
        if progress_callback:
            progress_callback(
                "ERROR: Working directory MUST contain a metadata directory. Remember to click the 'Export audiobook' button in the website!",
                0
            )
        return

    cover = [f for f in os.listdir(os.path.join(workingDir, "metadata")) if f.startswith("cover")]
    if len(cover) != 1:
        if progress_callback:
            progress_callback("ERROR: Cover art not found", 0)
        return

    with open(os.path.join(workingDir, "metadata", cover[0]), "rb") as f:
        coverBytes = f.read()
    coverMime = mimetypes.guess_type(cover[0])[0]

    # Open JSON file with UTF-8 encoding
    with open(os.path.join(workingDir, "metadata", "metadata.json"), "r", encoding="utf-8") as f:
        metadata = json.load(f)

    authorName = "Unknown"
    for creator in metadata["creator"]:
        if creator["role"] == "author":
            authorName = creator["name"]

    chapters = {}
    for chap in metadata["chapters"]:
        chapters.setdefault(chap["spine"], []).append(chap)

    # Collect all parts to process
    parts = [file for file in workingList if file.startswith("Part ")]
    total = len(parts)
    if total == 0:
        if progress_callback:
            progress_callback("ERROR: No parts found to process.", 0)
        return

    for index, file in enumerate(parts):
        number = file[len("Part "):].split(".")[0]

        audiofile = eyed3.load(os.path.join(workingDir, file))
        if audiofile.tag is None:
            # explizit ID3v2.4 initialisieren (UTF-8)
            audiofile.initTag(version=ID3_V2_4)
        else:
            audiofile.tag.clear()

        # make that we work with V2.4 and UTF-8
        audiofile.tag.version = ID3_V2_4

        audiofile.tag.title = f"Part {int(number)}"
        audiofile.tag.artist = authorName
        audiofile.tag.images.set(3, coverBytes, coverMime)
        audiofile.tag.album = metadata["title"]
        audiofile.tag.track_num = (int(number), len(metadata["spine"]))

        last = None
        child_ids = []

        for i, chap in enumerate(chapters.get(int(number) - 1, [])):
            if last is None:
                last = chap
                continue
            cid = f"ch{i}".encode("ascii")
            child_ids.append(cid)
            c = audiofile.tag.chapters.set(
                cid,
                (int(last["offset"]) * 1000, int(chap["offset"]) * 1000 - 1)
            )
            c.title = last["title"]
            last = chap

        if last is not None:
            c = audiofile.tag.chapters.set(
                b"last",
                (
                    int(last["offset"]) * 1000,
                    int(metadata["spine"][chap["spine"]]["duration"] * 1000)
                )
            )
            c.title = last["title"]

        audiofile.tag.table_of_contents.set(
            b"toc",
            toplevel=True,
            child_ids=child_ids + [b"last"],
            description="Table of Contents"
        )

        # als v2.4 speichern, damit UTF-8 Zeichen (Umlaute) korrekt sind
        audiofile.tag.save(version=ID3_V2_4)

        # Update progress
        if progress_callback:
            progress = int((index + 1) * 100 / total)
            progress_callback(f"Baked: {file}", progress)

# Worker class to run bake_metadata in a separate thread
class Worker(QtCore.QObject):
    progress = QtCore.pyqtSignal(str, int)
    finished = QtCore.pyqtSignal()
    error = QtCore.pyqtSignal(str)

    def __init__(self, path):
        super().__init__()
        self.path = path

    def run(self):
        try:
            bake_metadata(self.path, progress_callback=self.progress.emit)
        except Exception as e:
            self.error.emit(str(e))
        finally:
            self.finished.emit()

# -------- GUI SECTION --------

class MetadataBakerApp(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Bake Metadata")
        self.resize(500, 300)
        self.init_ui()

    def init_ui(self):
        layout = QtWidgets.QVBoxLayout()

        # Directory selection
        dir_layout = QtWidgets.QHBoxLayout()
        self.dirInput = QtWidgets.QLineEdit()
        self.browseBtn = QtWidgets.QPushButton("Browse")
        dir_layout.addWidget(self.dirInput)
        dir_layout.addWidget(self.browseBtn)

        # Run button
        self.runBtn = QtWidgets.QPushButton("Run Bake")

        # Progress bar
        self.progressBar = QtWidgets.QProgressBar()
        self.progressBar.setRange(0, 100)
        self.progressBar.setValue(0)

        # Log output
        self.logOutput = QtWidgets.QTextEdit()
        self.logOutput.setReadOnly(True)
        self.logOutput.setAcceptRichText(True)

        layout.addLayout(dir_layout)
        layout.addWidget(self.runBtn)
        layout.addWidget(self.progressBar)
        layout.addWidget(self.logOutput)
        self.setLayout(layout)

        self.browseBtn.clicked.connect(self.select_dir)
        self.runBtn.clicked.connect(self.run_bake)

    def select_dir(self):
        dir_path = QtWidgets.QFileDialog.getExistingDirectory(self, "Select Audiobook Directory")
        if dir_path:
            self.dirInput.setText(dir_path)

    def run_bake(self):
        path = self.dirInput.text().strip()
        self.logOutput.clear()

        if not os.path.isdir(path):
            self.logOutput.append("<span style='color:red;'>Invalid directory path.</span>")
            return

        self.progressBar.setValue(0)
        self.runBtn.setEnabled(False)
        self.browseBtn.setEnabled(False)

        self.thread = QtCore.QThread()
        self.worker = Worker(path)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.progress.connect(self.update_status)
        self.worker.error.connect(self.report_error)
        self.worker.finished.connect(self.process_finished)
        self.worker.finished.connect(self.thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.thread.finished.connect(self.thread.deleteLater)
        self.thread.start()

    def update_status(self, message, progress):
        if message.startswith("ERROR"):
            self.logOutput.append(f"<span style='color:red;'>{message}</span>")
        else:
            self.logOutput.append(message)
        self.progressBar.setValue(progress)

    def report_error(self, error_message):
        self.logOutput.append(f"<span style='color:red;'>Error: {error_message}</span>")

    def process_finished(self):
        self.logOutput.append("Processing complete.")
        self.runBtn.setEnabled(True)
        self.browseBtn.setEnabled(True)

# -------- MAIN ENTRY POINT --------

def main():
    parser = argparse.ArgumentParser(description="Bake audiobook metadata.")
    parser.add_argument("directory", nargs="?", default=None, help="Path to audiobook directory")
    parser.add_argument("--gui", action="store_true", help="Run in GUI mode")
    args = parser.parse_args()

    def cli_callback(message, progress):
        if message.startswith("ERROR"):
            print(f"\033[91m{message}\033[0m")
        else:
            print(f"{message} ({progress}%)")

    if args.gui:
        app = QtWidgets.QApplication(sys.argv)
        window = MetadataBakerApp()
        if args.directory:
            window.dirInput.setText(args.directory)

        def gui_log_callback(message, progress=0):
            if message.startswith("ERROR"):
                styled = f"<span style='color:red;'>{message}</span>"
            else:
                styled = message
            QtCore.QMetaObject.invokeMethod(
                window.logOutput,
                "append",
                QtCore.Qt.QueuedConnection,
                QtCore.Q_ARG(str, styled)
            )

        gui_handler = GuiLogHandler(lambda msg: gui_log_callback(msg))
        gui_handler.setFormatter(logging.Formatter('%(levelname)s: %(message)s'))
        gui_handler.setLevel(logging.WARNING)
        eyed3.log.addHandler(gui_handler)
        eyed3.log.propagate = False

        window.show()
        sys.exit(app.exec_())
    else:
        if args.directory:
            workingDir = args.directory
        else:
            workingDir = input("Path to audiobook dir: ").strip()
        bake_metadata(workingDir, progress_callback=cli_callback)

if __name__ == "__main__":
    main()
