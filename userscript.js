// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2025-03-27
// @description   Download books and audiobooks from Libby/Overdrive
// @author        PsychedelicPalimpsest
// @license       MIT
// @supportURL    https://github.com/PsychedelicPalimpsest/LibbyRip/issues
// @match         *://*.listen.libbyapp.com/*
// @match         *://*.listen.overdrive.com/*
// @match         *://*.read.libbyapp.com/?*
// @match         *://*.read.overdrive.com/?*
// @run-at        document-start
// @icon          https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @require       https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @grant         none
// ==/UserScript==

/*
DEV NOTES:
----------
- None of the metadata embedding functionality is working. Explore using lamejs or ffmpeg.wasm to embed metadata in the mp3 files.
- The zip file creation is extremely slow. Consider replacing JSZip with https://github.com/101arrowz/fflate.
*/

(() => {
  // Since the ffmpeg.js file is 50mb, it slows the page down too much
  // to be in a "require" attribute, so we load it in async
  function addFFmpegJs() {
    let scriptTag = document.createElement("script");
    scriptTag.setAttribute("type", "text/javascript");
    scriptTag.setAttribute(
      "src",
      "https://github.com/PsychedelicPalimpsest/FFmpeg-js/releases/download/14/0.12.5.bundle.js"
    );
    document.body.appendChild(scriptTag);

    return new Promise((accept) => {
      let i = setInterval(() => {
        if (window.createFFmpeg) {
          clearInterval(i);
          accept(window.createFFmpeg);
        }
      }, 50);
    });
  }

  let downloadElem;
  const CSS = `
  .pNav{
    background-color: red;
    width: 100%;
    display: flex;
    justify-content: space-between;
  }
  .pLink{
    color: blue;
    text-decoration-line: underline;
    padding: .25em;
    font-size: 1em;
  }
  .foldMenu{
    position: absolute;
    width: 100%;
    height: 0%;
    z-index: 1000;

    background-color: grey;
    color: white;

    overflow-x: hidden;
    overflow-y: scroll;

    transition: height 0.3s
  }
  .active{
    height: 40%;
    border: double;
  }
  .pChapLabel{
    font-size: 2em;
  }`;

  /* 
  =========================================
        BEGIN AUDIOBOOK SECTION!
  =========================================
  */

  // Libby, somewhere, gets the crypto stuff we need for mp3 urls, then removes it before adding it to the BIF.
  // here, we simply hook json parse to get it for us!

  const old_parse = JSON.parse;
  let odreadCmptParams = null;
  JSON.parse = function (...args) {
    let ret = old_parse(...args);
    if (
      typeof ret == "object" &&
      ret["b"] != undefined &&
      ret["b"]["-odread-cmpt-params"] != undefined
    ) {
      odreadCmptParams = Array.from(ret["b"]["-odread-cmpt-params"]);
    }

    return ret;
  };

  const audioBookNav = `
    <a class="pLink" id="chap"> <h1> View chapters </h1> </a>
    <a class="pLink" id="down"> <h1> Export as MP3 </h1> </a>
    <a class="pLink" id="exp"> <h1> Export audiobook </h1> </a>
  `;
  const chaptersMenu = `
    <h2>This book contains {CHAPTERS} chapters.</h2>
    <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
  `;
  let chapterMenuElem;

  function buildLibreUi() {
    // Create the nav
    let nav = document.createElement("div");
    nav.innerHTML = audioBookNav;
    nav.querySelector("#chap").onclick = viewChapters;
    nav.querySelector("#down").onclick = exportMP3;
    nav.querySelector("#exp").onclick = exportChapters;
    nav.classList.add("pNav");
    let pbar = document.querySelector(".nav-progress-bar");
    pbar.insertBefore(nav, pbar.children[1]);

    // Create the chapters menu
    chapterMenuElem = document.createElement("div");
    chapterMenuElem.classList.add("foldMenu");
    chapterMenuElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
    const urls = getUrls();

    chapterMenuElem.innerHTML = chaptersMenu.replace("{CHAPTERS}", urls.length);
    document.body.appendChild(chapterMenuElem);

    downloadElem = document.createElement("div");
    downloadElem.classList.add("foldMenu");
    downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
    document.body.appendChild(downloadElem);
  }
  function getUrls() {
    let ret = [];
    for (let spine of BIF.objects.spool.components) {
      let data = {
        url:
          location.origin +
          "/" +
          spine.meta.path +
          "?" +
          odreadCmptParams[spine.spinePosition],
        index: spine.meta["-odread-spine-position"],
        duration: spine.meta["audio-duration"],
        size: spine.meta["-odread-file-bytes"],
        type: spine.meta["media-type"],
      };
      ret.push(data);
    }
    return ret;
  }
  function paddy(num, padlen, padchar) {
    var pad_char = typeof padchar !== "undefined" ? padchar : "0";
    var pad = new Array(1 + padlen).join(pad_char);
    return (pad + num).slice(-pad.length);
  }
  let firstChapClick = true;
  function viewChapters() {
    // Populate chapters ONLY after first viewing
    if (firstChapClick) {
      firstChapClick = false;
      for (let url of getUrls()) {
        let span = document.createElement("span");
        span.classList.add("pChapLabel");
        span.textContent = "#" + (1 + url.index);

        let audio = document.createElement("audio");
        audio.setAttribute("controls", "");
        let source = document.createElement("source");
        source.setAttribute("src", url.url);
        source.setAttribute("type", url.type);
        audio.appendChild(source);

        chapterMenuElem.appendChild(span);
        chapterMenuElem.appendChild(document.createElement("br"));
        chapterMenuElem.appendChild(audio);
        chapterMenuElem.appendChild(document.createElement("br"));
      }
    }
    if (chapterMenuElem.classList.contains("active"))
      chapterMenuElem.classList.remove("active");
    else chapterMenuElem.classList.add("active");
    chapterMenuElem.querySelector("#dumpAll").onclick = async function () {
      chapterMenuElem.querySelector("#dumpAll").style.display = "none";

      await Promise.all(
        getUrls().map(async function (url) {
          const res = await fetch(url.url);
          const blob = await res.blob();

          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          const bookMetadata = getMetadata();
          const formattedTitle = formatTitleWithArticle(bookMetadata.title);
          const titlePart =
            formattedTitle +
            (bookMetadata.subtitle ? " - " + bookMetadata.subtitle : "");
          const authorPart = "[" + getAuthorString() + "]";
          link.download = `${titlePart} ${authorPart}.${paddy(
            url.index,
            3
          )}.mp3`;
          link.click();

          URL.revokeObjectURL(link.href);
        })
      );

      chapterMenuElem.querySelector("#dumpAll").style.display = "";
    };
  }
  function formatTitleWithArticle(title) {
    if (!title) return title;

    // List of articles to move to the end
    const articles = ["The", "A", "An"];

    for (const article of articles) {
      if (title.startsWith(article + " ")) {
        // Remove the article and space from the beginning
        const titleWithoutArticle = title.substring(article.length + 1);
        // Add the article to the end with a comma
        return titleWithoutArticle + ", " + article;
      }
    }

    // Return original title if no article found at the beginning
    return title;
  }

  function getAuthorString() {
    return BIF.map.creator
      .filter((creator) => creator.role === "author")
      .map((creator) => creator.name)
      .join(", ");
  }

  function getMetadata() {
    let spineToIndex = BIF.map.spine.map((x) => x["-odread-original-path"]);
    let metadata = {
      title: BIF.map.title.main,
      subtitle: BIF.map.title.subtitle || "",
      description: BIF.map.description,
      coverUrl: BIF.root.querySelector("image").getAttribute("href"),
      creator: BIF.map.creator,
      spine: BIF.map.spine.map((x) => {
        return {
          duration: x["audio-duration"],
          type: x["media-type"],
          bitrate: x["audio-bitrate"],
        };
      }),
    };
    if (BIF.map.nav.toc != undefined) {
      metadata.chapters = BIF.map.nav.toc.map((rChap) => {
        return {
          title: rChap.title,
          spine: spineToIndex.indexOf(rChap.path.split("#")[0]),
          offset: 1 * (rChap.path.split("#")[1] | 0),
        };
      });
    }
    return metadata;
  }

  async function createMetadata(zip) {
    let folder = zip.folder("metadata");
    let metadata = getMetadata();
    const response = await fetch(metadata.coverUrl);
    const blob = await response.blob();
    const csplit = metadata.coverUrl.split(".");
    folder.file("cover." + csplit[csplit.length - 1], blob, {
      compression: "STORE",
    });
    folder.file("metadata.json", JSON.stringify(metadata, null, 2));
  }
  function generateTOCFFmpeg(metadata) {
    if (!metadata.chapters) return null;
    let lastTitle = null;

    const duration =
      Math.round(
        BIF.map.spine
          .map((x) => x["audio-duration"])
          .reduce((acc, val) => acc + val)
      ) * 1000000000;

    let toc = ";FFMETADATA1\n\n";

    // Get the offset for each spine element
    let temp = 0;
    const spineSpecificOffset = BIF.map.spine.map((x) => {
      let old = temp;
      temp += x["audio-duration"] * 1;
      return old;
    });

    // Libby chapter split over many mp3s have duplicate chapters, so we must filter them
    // then convert them to be in [title, start_in_nanosecs]
    let chapters = metadata.chapters
      .filter((x) => {
        let ret = x.title !== lastTitle;
        lastTitle = x.title;
        return ret;
      })
      .map((x) => [
        // Escape the title
        x.title
          .replaceAll("\\", "\\\\")
          .replaceAll("#", "\\#")
          .replaceAll(";", "\\;")
          .replaceAll("=", "\\=")
          .replaceAll("\n", ""),
        // Calculate absolute offset in nanoseconds
        Math.round(spineSpecificOffset[x.spine] + x.offset) * 1000000000,
      ]);

    // Transform chapter to be [title, start_in_nanosecs, end_in_nanosecounds]
    let last = duration;
    for (let i = chapters.length - 1; -1 != i; i--) {
      chapters[i].push(last);
      last = chapters[i][1];
    }

    chapters.forEach((x) => {
      toc += "[CHAPTER]\n";
      toc += `START=${x[1]}\n`;
      toc += `END=${x[2]}\n`;
      toc += `title=${x[0]}\n`;
    });

    return toc;
  }

  let downloadState = -1;
  let ffmpeg = null;
  async function createAndDownloadMp3(urls) {
    if (!window.createFFmpeg) {
      downloadElem.innerHTML += "Downloading FFmpeg.wasm (~50mb) <br>";
      await addFFmpegJs();
      downloadElem.innerHTML += "Completed FFmpeg.wasm download <br>";
    }
    if (!ffmpeg) {
      downloadElem.innerHTML += "Initializing FFmpeg.wasm <br>";
      ffmpeg = await window.createFFmpeg();
      downloadElem.innerHTML += "FFmpeg.wasm initalized <br>";
    }
    let metadata = getMetadata();
    downloadElem.innerHTML += "Downloading mp3 files <br>";
    await ffmpeg.writeFile("chapters.txt", generateTOCFFmpeg(metadata));

    let fetchPromises = urls.map(async (url) => {
      // Download the mp3
      const response = await fetch(url.url);
      const blob = await response.blob();

      // Dump it into ffmpeg (We do the request here as not to bog down the worker thread)
      const blob_url = URL.createObjectURL(blob);
      await ffmpeg.writeFileFromUrl(url.index + 1 + ".mp3", blob_url);
      URL.revokeObjectURL(blob_url);

      downloadElem.innerHTML += `Download of disk ${
        url.index + 1
      } complete! <br>`;
      downloadElem.scrollTo(0, downloadElem.scrollHeight);
    });

    let coverName = null;

    if (metadata.coverUrl) {
      console.log(metadata.coverUrl);
      const csplit = metadata.coverUrl.split(".");
      const response = await fetch(metadata.coverUrl);
      const blob = await response.blob();

      coverName = "cover." + csplit[csplit.length - 1];

      const blob_url = URL.createObjectURL(blob);
      await ffmpeg.writeFileFromUrl(coverName, blob_url);
      URL.revokeObjectURL(blob_url);
    }

    await Promise.all(fetchPromises);

    downloadElem.innerHTML += `<br><b>Downloads complete!</b> Now combining them together! (This might take a <b><i>minute</i></b>) <br> Transcode progress: <span id="mp3Progress">0</span> hours in to audiobook<br>`;
    downloadElem.scrollTo(0, downloadElem.scrollHeight);

    let files = "";

    for (let i = 0; i < urls.length; i++) {
      files += `file '${i + 1}.mp3'\n`;
    }
    await ffmpeg.writeFile("files.txt", files);

    ffmpeg.setProgress((progress) => {
      // The progress.time feature seems to be in micro secounds
      downloadElem.querySelector("#mp3Progress").textContent = (
        progress.time /
        1000000 /
        3600
      ).toFixed(2);
    });
    ffmpeg.setLogger(console.log);

    await ffmpeg.exec(
      ["-y", "-f", "concat", "-i", "files.txt", "-i", "chapters.txt"]
        .concat(coverName ? ["-i", coverName] : [])
        .concat([
          "-map_metadata",
          "1",
          "-codec",
          "copy",
          "-map",
          "0:a",
          "-metadata",
          `title=${metadata.title}`,
          "-metadata",
          `album=${metadata.title}`,
          "-metadata",
          `artist=${getAuthorString()}`,
          "-metadata",
          `encoded_by=LibbyRip/LibreGRAB`,
          "-c:a",
          "copy",
        ])
        .concat(
          coverName
            ? [
                "-map",
                "2:v",
                "-metadata:s:v",
                "title=Album cover",
                "-metadata:s:v",
                "comment=Cover (front)",
              ]
            : []
        )
        .concat(["out.mp3"])
    );

    let blob_url = await ffmpeg.readFileToUrl("out.mp3");

    const link = document.createElement("a");
    link.href = blob_url;

    const bookMetadata = getMetadata();
    const formattedTitle = formatTitleWithArticle(bookMetadata.title);
    const titlePart =
      formattedTitle +
      (bookMetadata.subtitle ? " - " + bookMetadata.subtitle : "");
    const authorPart = "[" + getAuthorString() + "]";
    link.download = titlePart + " " + authorPart + ".mp3";
    document.body.appendChild(link);
    link.click();
    link.remove();

    downloadState = -1;
    downloadElem.innerHTML = "";
    downloadElem.classList.remove("active");

    // Clean up the object URL
    setTimeout(() => URL.revokeObjectURL(blob_url), 100);
  }
  function exportMP3() {
    if (downloadState != -1) return;

    downloadState = 0;
    downloadElem.classList.add("active");
    downloadElem.innerHTML = "<b>Starting MP3</b><br>";
    createAndDownloadMp3(getUrls()).then((p) => {});
  }

  async function createAndDownloadZip(urls, addMeta) {
    // Create a web worker to handle zip creation in the background
    const workerBlob = new Blob(
      [
        `
      self.importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js');
      
      self.onmessage = async function(e) {
        const { urls, addMeta, metadataInfo, combinedMp3Info } = e.data;
        const zip = new JSZip();
        const mp3Buffers = [];
        
        // Fetch all files and add them to the zip
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          const response = await fetch(url.url);
          const blob = await response.blob();
          const filename = "Part " + paddy(url.index + 1, 3) + ".mp3";
          
          // Store the MP3 data for concatenation
          const arrayBuffer = await blob.arrayBuffer();
          mp3Buffers.push({ index: url.index, buffer: arrayBuffer });
          
          // Report progress back to the main thread
          self.postMessage({ 
            type: 'progress', 
            index: url.index,
            filename: filename,
            completed: i + 1,
            total: urls.length
          });
          
          zip.file(filename, blob, { compression: "STORE" });
        }
        
        // Signal that ALL individual downloads are complete before moving on
        self.postMessage({ type: 'downloadsCompleted' });
        
        // Sort MP3 buffers by index to ensure correct order
        mp3Buffers.sort((a, b) => a.index - b.index);
        
        // Create combined MP3 using binary concatenation
        self.postMessage({ type: 'combiningMp3' });
        
        // Get cover image for embedding
        let coverImageData = null;
        let coverMimeType = null;
        if (addMeta && metadataInfo.coverUrl) {
          try {
            const coverResponse = await fetch(metadataInfo.coverUrl);
            const coverArrayBuffer = await coverResponse.arrayBuffer();
            coverImageData = new Uint8Array(coverArrayBuffer);
            
            // Determine MIME type from URL
            const coverUrl = metadataInfo.coverUrl.toLowerCase();
            if (coverUrl.includes('.jpg') || coverUrl.includes('.jpeg')) {
              coverMimeType = 'image/jpeg';
            } else if (coverUrl.includes('.png')) {
              coverMimeType = 'image/png';
            } else {
              coverMimeType = 'image/jpeg'; // Default fallback
            }
          } catch (error) {
            console.warn('Failed to fetch cover image for embedding:', error);
          }
        }
        
        const combinedMp3 = concatenateMP3s(
          mp3Buffers.map(item => item.buffer), 
          metadataInfo, 
          coverImageData, 
          coverMimeType
        );
        const combinedBlob = new Blob([combinedMp3], { type: 'audio/mpeg' });
        
        // Add combined MP3 to zip
        zip.file(combinedMp3Info.filename, combinedBlob, { compression: "STORE" });
        self.postMessage({ type: 'combinedMp3Added' });
        
        if (addMeta) {
          // Handle metadata in the worker
          const folder = zip.folder("metadata");
          
          // Cover image
          const coverResponse = await fetch(metadataInfo.coverUrl);
          const coverBlob = await coverResponse.blob();
          const csplit = metadataInfo.coverUrl.split(".");
          folder.file("cover." + csplit[csplit.length-1], coverBlob, { compression: "STORE" });
          
          // Metadata JSON
          folder.file("metadata.json", JSON.stringify(metadataInfo, null, 2));
          
          self.postMessage({ type: 'metadataCompleted' });
        }
        
        // Generate the zip file with progress reporting
        zip.generateAsync({
          type: 'blob',
          compression: "STORE",
          streamFiles: true,
        }, (meta) => {
          if (meta.percent) {
            self.postMessage({ type: 'zipProgress', percent: meta.percent });
          }
        }).then(blob => {
          self.postMessage({ type: 'complete', blob: blob });
        });
      };
      
      function concatenateMP3s(mp3ArrayBuffers, metadata, coverImageData, coverMimeType) {
        if (mp3ArrayBuffers.length === 0) return new ArrayBuffer(0);
        
        // Create ID3v2 tag with metadata and cover art
        const id3Tag = createID3v2Tag(metadata, coverImageData, coverMimeType);
        
        // Calculate total size of audio data (skipping ID3 tags from all files)
        const processedBuffers = mp3ArrayBuffers.map((buffer, index) => {
          return skipID3v2Tag(buffer);
        });
        
        const audioDataSize = processedBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
        const totalSize = id3Tag.byteLength + audioDataSize;
        
        // Create the combined buffer
        const combined = new ArrayBuffer(totalSize);
        const combinedView = new Uint8Array(combined);
        
        // Add ID3v2 tag at the beginning
        let offset = 0;
        combinedView.set(new Uint8Array(id3Tag), offset);
        offset += id3Tag.byteLength;
        
        // Add all audio data
        for (const buffer of processedBuffers) {
          const view = new Uint8Array(buffer);
          combinedView.set(view, offset);
          offset += buffer.byteLength;
        }
        
        return combined;
      }
      
      function skipID3v2Tag(arrayBuffer) {
        const view = new Uint8Array(arrayBuffer);
        
        // Check for ID3v2 tag (starts with "ID3")
        if (view.length >= 10 && 
            view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
          
          // Parse ID3v2 tag size (synchsafe integer in bytes 6-9)
          const size = ((view[6] & 0x7F) << 21) |
                      ((view[7] & 0x7F) << 14) |
                      ((view[8] & 0x7F) << 7) |
                      (view[9] & 0x7F);
          
          // Skip the 10-byte header + tag size
          const skipBytes = 10 + size;
          if (skipBytes < view.length) {
            return arrayBuffer.slice(skipBytes);
          }
        }
        
        // No ID3v2 tag found or tag is malformed, return original buffer
        return arrayBuffer;
      }
      
      function createID3v2Tag(metadata, coverImageData, coverMimeType) {
        const frames = [];
        
        // Create text frames
        if (metadata && metadata.title) {
          frames.push(createTextFrame('TIT2', metadata.title)); // Title
        }
        if (metadata && metadata.creator && metadata.creator.length > 0) {
          const artists = metadata.creator
            .filter(c => c.role === 'author')
            .map(c => c.name)
            .join(', ');
          if (artists) {
            frames.push(createTextFrame('TPE1', artists)); // Artist
            frames.push(createTextFrame('TPE2', artists)); // Album Artist
          }
        }
        if (metadata && metadata.title) {
          frames.push(createTextFrame('TALB', metadata.title)); // Album
        }
        
        // Add cover art frame if available
        if (coverImageData && coverMimeType) {
          frames.push(createAPICFrame(coverImageData, coverMimeType));
        }
        
        // Add chapter frames if available
        if (metadata && metadata.chapters && metadata.spine) {
          const chapterFrames = createChapterFrames(metadata.chapters, metadata.spine);
          frames.push(...chapterFrames);
        }
        
        // Calculate total frames size
        const framesSize = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
        const headerSize = 10;
        const totalTagSize = headerSize + framesSize;
        
        // Create ID3v2 header
        const header = new ArrayBuffer(headerSize);
        const headerView = new Uint8Array(header);
        
        // ID3v2 identifier
        headerView[0] = 0x49; // 'I'
        headerView[1] = 0x44; // 'D'
        headerView[2] = 0x33; // '3'
        
        // Version (2.3.0)
        headerView[3] = 0x03; // Major version
        headerView[4] = 0x00; // Revision
        
        // Flags
        headerView[5] = 0x00;
        
        // Size (synchsafe integer - excluding header)
        const sizeBytes = encodeSize(framesSize);
        headerView[6] = sizeBytes[0];
        headerView[7] = sizeBytes[1];
        headerView[8] = sizeBytes[2];
        headerView[9] = sizeBytes[3];
        
        // Combine header and frames
        const tag = new ArrayBuffer(totalTagSize);
        const tagView = new Uint8Array(tag);
        
        tagView.set(new Uint8Array(header), 0);
        let offset = headerSize;
        
        for (const frame of frames) {
          tagView.set(new Uint8Array(frame), offset);
          offset += frame.byteLength;
        }
        
        return tag;
      }
      
      function createTextFrame(frameId, text) {
        const textBytes = new TextEncoder().encode(text);
        const frameSize = 1 + textBytes.byteLength; // 1 byte for encoding + text
        const totalSize = 10 + frameSize; // 10 byte header + frame data
        
        const frame = new ArrayBuffer(totalSize);
        const view = new Uint8Array(frame);
        
        // Frame header
        for (let i = 0; i < 4; i++) {
          view[i] = frameId.charCodeAt(i);
        }
        
        // Size (4 bytes, big-endian)
        view[4] = (frameSize >>> 24) & 0xFF;
        view[5] = (frameSize >>> 16) & 0xFF;
        view[6] = (frameSize >>> 8) & 0xFF;
        view[7] = frameSize & 0xFF;
        
        // Flags (2 bytes)
        view[8] = 0x00;
        view[9] = 0x00;
        
        // Frame data
        view[10] = 0x03; // UTF-8 encoding
        view.set(textBytes, 11);
        
        return frame;
      }
      
      function createAPICFrame(imageData, mimeType) {
        const mimeBytes = new TextEncoder().encode(mimeType);
        const descBytes = new TextEncoder().encode('Cover'); // Description
        
        const frameDataSize = 1 + mimeBytes.byteLength + 1 + 1 + descBytes.byteLength + 1 + imageData.byteLength;
        const totalSize = 10 + frameDataSize;
        
        const frame = new ArrayBuffer(totalSize);
        const view = new Uint8Array(frame);
        
        // Frame header - APIC
        view[0] = 0x41; // 'A'
        view[1] = 0x50; // 'P'
        view[2] = 0x49; // 'I'
        view[3] = 0x43; // 'C'
        
        // Size (4 bytes, big-endian)
        view[4] = (frameDataSize >>> 24) & 0xFF;
        view[5] = (frameDataSize >>> 16) & 0xFF;
        view[6] = (frameDataSize >>> 8) & 0xFF;
        view[7] = frameDataSize & 0xFF;
        
        // Flags (2 bytes)
        view[8] = 0x00;
        view[9] = 0x00;
        
        // Frame data
        let offset = 10;
        
        // Text encoding (UTF-8)
        view[offset++] = 0x03;
        
        // MIME type
        view.set(mimeBytes, offset);
        offset += mimeBytes.byteLength;
        view[offset++] = 0x00; // Null terminator
        
        // Picture type (3 = Cover front)
        view[offset++] = 0x03;
        
        // Description
        view.set(descBytes, offset);
        offset += descBytes.byteLength;
        view[offset++] = 0x00; // Null terminator
        
        // Image data
        view.set(imageData, offset);
        
        return frame;
      }
      
      function createChapterFrames(chapters, spine) {
        const frames = [];
        
        // Calculate cumulative spine durations
        const spineOffsets = [];
        let cumulativeDuration = 0;
        for (let i = 0; i < spine.length; i++) {
          spineOffsets[i] = cumulativeDuration;
          cumulativeDuration += spine[i].duration;
        }
        
        // Process chapters and create CHAP frames
        for (let i = 0; i < chapters.length; i++) {
          const chapter = chapters[i];
          const nextChapter = chapters[i + 1];
          
          // Calculate absolute start time in milliseconds
          const startTimeMs = Math.round((spineOffsets[chapter.spine] + chapter.offset) * 1000);
          
          // Calculate end time
          let endTimeMs;
          if (nextChapter) {
            endTimeMs = Math.round((spineOffsets[nextChapter.spine] + nextChapter.offset) * 1000);
          } else {
            // Last chapter ends at the total duration
            endTimeMs = Math.round(cumulativeDuration * 1000);
          }
          
          // Create chapter ID
          const chapterId = 'ch' + (i + 1).toString().padStart(3, '0');
          
          // Create CHAP frame
          frames.push(createCHAPFrame(chapterId, startTimeMs, endTimeMs, chapter.title));
        }
        
        return frames;
      }
      
      function createCHAPFrame(chapterId, startTimeMs, endTimeMs, title) {
        const chapterIdBytes = new TextEncoder().encode(chapterId);
        
        // Create TIT2 sub-frame for chapter title
        const tit2Frame = createTIT2SubFrame(title);
        
        // Calculate frame data size
        const frameDataSize = chapterIdBytes.byteLength + 1 + // Chapter ID + null terminator
                             4 + 4 + 4 + 4 + // Start/End time + Start/End byte offset
                             tit2Frame.byteLength; // Sub-frame
        
        const totalSize = 10 + frameDataSize; // Header + data
        
        const frame = new ArrayBuffer(totalSize);
        const view = new Uint8Array(frame);
        
        // Frame header - CHAP
        view[0] = 0x43; // 'C'
        view[1] = 0x48; // 'H'
        view[2] = 0x41; // 'A'
        view[3] = 0x50; // 'P'
        
        // Size (4 bytes, big-endian)
        view[4] = (frameDataSize >>> 24) & 0xFF;
        view[5] = (frameDataSize >>> 16) & 0xFF;
        view[6] = (frameDataSize >>> 8) & 0xFF;
        view[7] = frameDataSize & 0xFF;
        
        // Flags (2 bytes)
        view[8] = 0x00;
        view[9] = 0x00;
        
        // Frame data
        let offset = 10;
        
        // Chapter ID
        view.set(chapterIdBytes, offset);
        offset += chapterIdBytes.byteLength;
        view[offset++] = 0x00; // Null terminator
        
        // Start time (4 bytes, big-endian, milliseconds)
        view[offset++] = (startTimeMs >>> 24) & 0xFF;
        view[offset++] = (startTimeMs >>> 16) & 0xFF;
        view[offset++] = (startTimeMs >>> 8) & 0xFF;
        view[offset++] = startTimeMs & 0xFF;
        
        // End time (4 bytes, big-endian, milliseconds)
        view[offset++] = (endTimeMs >>> 24) & 0xFF;
        view[offset++] = (endTimeMs >>> 16) & 0xFF;
        view[offset++] = (endTimeMs >>> 8) & 0xFF;
        view[offset++] = endTimeMs & 0xFF;
        
        // Start byte offset (4 bytes, 0xFFFFFFFF = not used)
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        
        // End byte offset (4 bytes, 0xFFFFFFFF = not used)
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        view[offset++] = 0xFF;
        
        // Sub-frame (TIT2 with chapter title)
        view.set(new Uint8Array(tit2Frame), offset);
        
        return frame;
      }
      
      function createTIT2SubFrame(title) {
        const titleBytes = new TextEncoder().encode(title);
        const frameSize = 1 + titleBytes.byteLength; // 1 byte for encoding + text
        const totalSize = 10 + frameSize; // 10 byte header + frame data
        
        const frame = new ArrayBuffer(totalSize);
        const view = new Uint8Array(frame);
        
        // Frame header - TIT2
        view[0] = 0x54; // 'T'
        view[1] = 0x49; // 'I'
        view[2] = 0x54; // 'T'
        view[3] = 0x32; // '2'
        
        // Size (4 bytes, big-endian)
        view[4] = (frameSize >>> 24) & 0xFF;
        view[5] = (frameSize >>> 16) & 0xFF;
        view[6] = (frameSize >>> 8) & 0xFF;
        view[7] = frameSize & 0xFF;
        
        // Flags (2 bytes)
        view[8] = 0x00;
        view[9] = 0x00;
        
        // Frame data
        view[10] = 0x03; // UTF-8 encoding
        view.set(titleBytes, 11);
        
        return frame;
      }
      
      function encodeSize(size) {
        // Encode as synchsafe integer (7 bits per byte)
        return [
          (size >>> 21) & 0x7F,
          (size >>> 14) & 0x7F,
          (size >>> 7) & 0x7F,
          size & 0x7F
        ];
      }
      
      function paddy(num, padlen, padchar) {
        var pad_char = typeof padchar !== 'undefined' ? padchar : '0';
        var pad = new Array(1 + padlen).join(pad_char);
        return (pad + num).slice(-pad.length);
      }
    `,
      ],
      { type: "application/javascript" }
    );

    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);

    return new Promise((resolve) => {
      worker.onmessage = function (e) {
        const data = e.data;

        if (data.type === "progress") {
          let partElem = document.createElement("div");
          partElem.textContent = "Download of " + data.filename + " complete";
          downloadElem.appendChild(partElem);
          downloadElem.scrollTo(0, downloadElem.scrollHeight);
          downloadState += 1;
        } else if (data.type === "downloadsCompleted") {
          downloadElem.innerHTML += "<br>All downloads completed!<br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);
        } else if (data.type === "combiningMp3") {
          downloadElem.innerHTML += "Combining MP3 files...<br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);
        } else if (data.type === "combinedMp3Added") {
          downloadElem.innerHTML += "Combined MP3 added to zip<br>";
          downloadElem.innerHTML += "<br>Creating zip file...<br>";
          downloadElem.innerHTML += "Zip progress: <b id='zipProg'>0</b>%<br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);
        } else if (data.type === "metadataCompleted") {
          downloadElem.innerHTML += "Metadata added to zip<br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);
        } else if (data.type === "zipProgress") {
          if (downloadElem.querySelector("#zipProg")) {
            downloadElem.querySelector("#zipProg").textContent =
              data.percent.toFixed(2);
          }
        } else if (data.type === "complete") {
          downloadElem.innerHTML += "Generated zip file! <br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);

          // Create a download link for the zip file
          const downloadUrl = URL.createObjectURL(data.blob);

          downloadElem.innerHTML += "Generated zip file link! <br>";
          downloadElem.scrollTo(0, downloadElem.scrollHeight);

          const link = document.createElement("a");
          link.href = downloadUrl;
          const bookMetadata = getMetadata();
          const formattedTitle = formatTitleWithArticle(bookMetadata.title);
          const titlePart =
            formattedTitle +
            (bookMetadata.subtitle ? " - " + bookMetadata.subtitle : "");
          const authorPart = "[" + getAuthorString() + "]";
          link.download = titlePart + " " + authorPart + ".zip";
          document.body.appendChild(link);
          link.click();
          link.remove();

          downloadState = -1;
          downloadElem.innerHTML = "";
          downloadElem.classList.remove("active");

          // Clean up resources
          URL.revokeObjectURL(downloadUrl);
          URL.revokeObjectURL(workerUrl);
          worker.terminate();

          resolve();
        }
      };

      // Add message for user
      downloadElem.innerHTML +=
        "<br><b>Downloads running in background!</b> You can switch to other tabs while this continues.<br>";
      downloadElem.scrollTo(0, downloadElem.scrollHeight);

      // Start the worker
      const bookMetadata = getMetadata();
      const formattedTitle = formatTitleWithArticle(bookMetadata.title);
      const titlePart =
        formattedTitle +
        (bookMetadata.subtitle ? " - " + bookMetadata.subtitle : "");
      const authorPart = "[" + getAuthorString() + "]";
      const combinedMp3Filename = titlePart + " " + authorPart + ".mp3";

      worker.postMessage({
        urls: urls,
        addMeta: addMeta,
        metadataInfo: addMeta ? bookMetadata : null,
        combinedMp3Info: { filename: combinedMp3Filename },
      });
    });
  }

  function exportChapters() {
    if (downloadState != -1) return;

    downloadState = 0;
    downloadElem.classList.add("active");
    downloadElem.innerHTML = "<b>Starting export</b><br>";
    createAndDownloadZip(getUrls(), true).then((p) => {});
  }

  // Main entry point for audiobooks
  function bifFoundAudiobook() {
    // New global style info
    let s = document.createElement("style");
    s.innerHTML = CSS;
    document.head.appendChild(s);
    if (odreadCmptParams == null) {
      alert(
        "odreadCmptParams not set, so cannot resolve book urls! Please try refreshing."
      );
      return;
    }

    buildLibreUi();
  }

  /* =========================================
        END AUDIOBOOK SECTION!
     =========================================
  */

  /* =========================================
        BEGIN BOOK SECTION!
     =========================================
  */
  const bookNav = `
    <div style="text-align: center; width: 100%;">
       <a class="pLink" id="download"> <h1> Download EPUB </h1> </a>
    </div>
  `;
  window.pages = {};

  // Libby used the bind method as a way to "safely" expose
  // the decryption module. THIS IS THEIR DOWNFALL.
  // As we can hook bind, allowing us to obtain the
  // decryption function
  const originalBind = Function.prototype.bind;
  Function.prototype.bind = function (...args) {
    const boundFn = originalBind.apply(this, args);
    boundFn.__boundArgs = args.slice(1); // Store bound arguments (excluding `this`)
    return boundFn;
  };

  async function waitForChapters(callback) {
    let components = getBookComponents();
    // Force all the chapters to load in.
    components.forEach((page) => {
      if (undefined != window.pages[page.id]) return;
      page._loadContent({ callback: () => {} });
    });
    // But its not instant, so we need to wait until they are all set (see: bifFound())
    while (
      components.filter((page) => undefined == window.pages[page.id]).length
    ) {
      await new Promise((r) => setTimeout(r, 100));
      callback();
      console.log(
        components.filter((page) => undefined == window.pages[page.id]).length
      );
    }
  }
  function getBookComponents() {
    return BIF.objects.reader._.context.spine._.components.filter(
      (p) => "hidden" != (p.block || {}).behavior
    );
  }
  function truncate(path) {
    return path.substring(path.lastIndexOf("/") + 1);
  }
  function goOneLevelUp(url) {
    let u = new URL(url);
    if (u.pathname === "/") return url; // Already at root

    u.pathname = u.pathname.replace(/\/[^/]*\/?$/, "/");
    return u.toString();
  }
  function getFilenameFromURL(url) {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    return pathname.substring(pathname.lastIndexOf("/") + 1);
  }
  async function createContent(oebps, imgAssests) {
    let cssRegistry = {};

    let components = getBookComponents();
    let totComp = components.length;
    downloadElem.innerHTML += `Gathering chapters <span id="chapAcc"> 0/${totComp} </span><br>`;
    downloadElem.scrollTo(0, downloadElem.scrollHeight);

    let gc = 0;
    await waitForChapters(() => {
      gc += 1;
      downloadElem.querySelector("span#chapAcc").innerHTML = ` ${
        components.filter((page) => undefined != window.pages[page.id]).length
      }/${totComp}`;
    });

    downloadElem.innerHTML += `Chapter gathering complete<br>`;
    downloadElem.scrollTo(0, downloadElem.scrollHeight);

    let idToIfram = {};
    let idToMetaId = {};
    components.forEach((c) => {
      // Nothing that can be done here...
      if (c.sheetBox.querySelector("iframe") == null) {
        console.warn("!!!" + window.pages[c.id]);
        return;
      }
      c.meta.id = c.meta.id || crypto.randomUUID();
      idToMetaId[c.id] = c.meta.id;
      idToIfram[c.id] = c.sheetBox.querySelector("iframe");

      c.sheetBox
        .querySelector("iframe")
        .contentWindow.document.querySelectorAll("link")
        .forEach((link) => {
          cssRegistry[c.id] = cssRegistry[c.id] || [];
          cssRegistry[c.id].push(link.href);

          if (imgAssests.includes(link.href)) return;
          imgAssests.push(link.href);
        });
    });
    let url = location.origin;
    for (let i of Object.keys(window.pages)) {
      if (idToIfram[i]) url = idToIfram[i].src;
      oebps.file(
        truncate(i),
        fixXhtml(
          idToMetaId[i],
          url,
          window.pages[i],
          imgAssests,
          cssRegistry[i] || []
        )
      );
    }

    downloadElem.innerHTML += `Downloading assets <span id="assetGath"> 0/${imgAssests.length} </span><br>`;
    downloadElem.scrollTo(0, downloadElem.scrollHeight);

    gc = 0;
    await Promise.all(
      imgAssests.map((name) =>
        (async function () {
          const response = await fetch(
            name.startsWith("http") ? name : location.origin + "/" + name
          );
          if (response.status != 200) {
            downloadElem.innerHTML += `<b>WARNING:</b> Could not fetch ${name}<br>`;
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
            return;
          }
          const blob = await response.blob();

          oebps.file(
            name.startsWith("http") ? getFilenameFromURL(name) : name,
            blob,
            { compression: "STORE" }
          );

          gc += 1;
          downloadElem.querySelector(
            "span#assetGath"
          ).innerHTML = ` ${gc}/${imgAssests.length} `;
        })()
      )
    );
  }
  function enforceEpubXHTML(metaId, url, htmlString, assetRegistry, links) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, "text/html");
    const bod = doc.querySelector("body");
    if (bod) {
      bod.setAttribute("id", metaId);
    }

    // Convert all elements to lowercase tag names
    const elements = doc.getElementsByTagName("*");
    for (let el of elements) {
      const newElement = doc.createElement(el.tagName.toLowerCase());

      // Copy attributes to the new element
      for (let attr of el.attributes) {
        newElement.setAttribute(attr.name, attr.value);
      }

      // Move child nodes to the new element
      while (el.firstChild) {
        newElement.appendChild(el.firstChild);
      }

      // Replace old element with the new one
      el.parentNode.replaceChild(newElement, el);
    }

    for (let el of elements) {
      if (
        el.tagName.toLowerCase() == "img" ||
        el.tagName.toLowerCase() == "image"
      ) {
        let src = el.getAttribute("src") || el.getAttribute("xlink:href");
        if (!src) continue;

        if (!(src.startsWith("http://") || src.startsWith("https://"))) {
          src = new URL(src, new URL(url)).toString();
        }
        if (!assetRegistry.includes(src)) assetRegistry.push(src);

        if (el.getAttribute("src")) el.setAttribute("src", truncate(src));
        if (el.getAttribute("xlink:href"))
          el.setAttribute("xlink:href", truncate(src));
      }
    }

    // Ensure the <head> element exists with a <title>
    let head = doc.querySelector("head");
    if (!head) {
      head = doc.createElement("head");
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }

    let title = head.querySelector("title");
    if (!title) {
      title = doc.createElement("title");
      title.textContent = BIF.map.title.main; // Default title
      head.appendChild(title);
    }

    for (let link of links) {
      let src = link;
      if (!(src.startsWith("http://") || src.startsWith("https://"))) {
        src = new URL(src, new URL(url)).toString();
      }
      let linkElement = doc.createElement("link");
      linkElement.setAttribute("href", truncate(src));
      linkElement.setAttribute("rel", "stylesheet");
      linkElement.setAttribute("type", "text/css");
      head.appendChild(linkElement);
    }

    // Get the serialized XHTML string
    const serializer = new XMLSerializer();
    let xhtmlString = serializer.serializeToString(doc);

    // Ensure proper namespaces (if not already present)
    if (!xhtmlString.includes('xmlns="http://www.w3.org/1999/xhtml"')) {
      xhtmlString = xhtmlString.replace(
        "<html>",
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">'
      );
    }

    return xhtmlString;
  }
  function fixXhtml(metaId, url, html, assetRegistry, links) {
    html =
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
` +
      enforceEpubXHTML(
        metaId,
        url,
        `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">` +
          html +
          `</html>`,
        assetRegistry,
        links
      );

    return html;
  }
  function getMimeTypeFromFileName(fileName) {
    const mimeTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      bmp: "image/bmp",
      webp: "image/webp",
      mp4: "video/mp4",
      mp3: "audio/mp3",
      pdf: "application/pdf",
      txt: "text/plain",
      html: "text/html",
      css: "text/css",
      json: "application/json",
      // Add more extensions as needed
    };

    const ext = fileName.split(".").pop().toLowerCase();
    return mimeTypes[ext] || "application/octet-stream";
  }
  function makePackage(oebps, assetRegistry) {
    const idStore = [];
    const doc = document.implementation.createDocument(
      "http://www.idpf.org/2007/opf", // default namespace
      "package", // root element name
      null // do not specify a doctype
    );

    // Step 2: Set attributes for the root element
    const packageElement = doc.documentElement;
    packageElement.setAttribute("version", "2.0");
    packageElement.setAttribute("xml:lang", "en");
    packageElement.setAttribute("unique-identifier", "pub-identifier");
    packageElement.setAttribute("xmlns", "http://www.idpf.org/2007/opf");
    packageElement.setAttribute("xmlns:dc", "http://purl.org/dc/elements/1.1/");
    packageElement.setAttribute("xmlns:dcterms", "http://purl.org/dc/terms/");

    // Step 3: Create and append child elements to the root
    const metadata = doc.createElementNS(
      "http://www.idpf.org/2007/opf",
      "metadata"
    );
    packageElement.appendChild(metadata);

    // Create child elements for metadata
    const dcIdentifier = doc.createElementNS(
      "http://purl.org/dc/elements/1.1/",
      "dc:identifier"
    );
    dcIdentifier.setAttribute("id", "pub-identifier");
    dcIdentifier.textContent = "" + BIF.map["-odread-buid"];
    metadata.appendChild(dcIdentifier);

    // Language
    if (BIF.map.language.length) {
      const dcLanguage = doc.createElementNS(
        "http://purl.org/dc/elements/1.1/",
        "dc:language"
      );
      dcLanguage.setAttribute("xsi:type", "dcterms:RFC4646");
      dcLanguage.textContent = BIF.map.language[0];
      packageElement.setAttribute("xml:lang", BIF.map.language[0]);
      metadata.appendChild(dcLanguage);
    }

    // Identifier
    const metaIdentifier = doc.createElementNS(
      "http://www.idpf.org/2007/opf",
      "meta"
    );
    metaIdentifier.setAttribute("id", "meta-identifier");
    metaIdentifier.setAttribute("property", "dcterms:identifier");
    metaIdentifier.textContent = "" + BIF.map["-odread-buid"];
    metadata.appendChild(metaIdentifier);

    // Title
    const dcTitle = doc.createElementNS(
      "http://purl.org/dc/elements/1.1/",
      "dc:title"
    );
    dcTitle.setAttribute("id", "pub-title");
    dcTitle.textContent = BIF.map.title.main;
    metadata.appendChild(dcTitle);

    // Creator (Author)
    if (BIF.map.creator.length) {
      const dcCreator = doc.createElementNS(
        "http://purl.org/dc/elements/1.1/",
        "dc:creator"
      );
      dcCreator.textContent = BIF.map.creator[0].name;
      metadata.appendChild(dcCreator);
    }

    // Description
    if (BIF.map.description) {
      // Remove HTML tags
      let p = document.createElement("p");
      p.innerHTML = BIF.map.description.full;

      const dcDescription = doc.createElementNS(
        "http://purl.org/dc/elements/1.1/",
        "dc:description"
      );
      dcDescription.textContent = p.textContent;
      metadata.appendChild(dcDescription);
    }

    // Step 4: Create the manifest, spine, guide, and other sections...
    const manifest = doc.createElementNS(
      "http://www.idpf.org/2007/opf",
      "manifest"
    );
    packageElement.appendChild(manifest);

    const spine = doc.createElementNS("http://www.idpf.org/2007/opf", "spine");
    spine.setAttribute("toc", "ncx");
    packageElement.appendChild(spine);

    const item = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
    item.setAttribute("id", "ncx");
    item.setAttribute("href", "toc.ncx");
    item.setAttribute("media-type", "application/x-dtbncx+xml");
    manifest.appendChild(item);

    // Generate out the manifest
    let components = getBookComponents();
    components.forEach((chapter) => {
      const item = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
      let id = chapter.meta.id;
      if (idStore.includes(id)) {
        id = id + "-" + crypto.randomUUID();
      }
      item.setAttribute("id", id);
      idStore.push(id);
      item.setAttribute("href", truncate(chapter.meta.path));
      item.setAttribute("media-type", "application/xhtml+xml");
      manifest.appendChild(item);

      const itemref = doc.createElementNS(
        "http://www.idpf.org/2007/opf",
        "itemref"
      );
      itemref.setAttribute("idref", chapter.meta.id);
      itemref.setAttribute("linear", "yes");
      spine.appendChild(itemref);
    });

    assetRegistry.forEach((asset) => {
      const item = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
      let aname = asset.startsWith("http") ? getFilenameFromURL(asset) : asset;
      let id = aname.split(".")[0];
      if (idStore.includes(id)) {
        id = id + "-" + crypto.randomUUID();
      }
      item.setAttribute("id", id);
      idStore.push(id);
      item.setAttribute("href", aname);
      item.setAttribute("media-type", getMimeTypeFromFileName(aname));
      manifest.appendChild(item);
    });

    // Step 5: Serialize the document to a string
    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(doc);

    oebps.file(
      "content.opf",
      `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
    );
  }
  function makeToc(oebps) {
    // Step 1: Create the document with a default namespace
    const doc = document.implementation.createDocument(
      "http://www.daisy.org/z3986/2005/ncx/", // default namespace
      "ncx", // root element name
      null // do not specify a doctype
    );

    // Step 2: Set attributes for the root element
    const ncxElement = doc.documentElement;
    ncxElement.setAttribute("version", "2005-1");

    // Step 3: Create and append child elements to the root
    const head = doc.createElementNS(
      "http://www.daisy.org/z3986/2005/ncx/",
      "head"
    );
    ncxElement.appendChild(head);

    const uidMeta = doc.createElementNS(
      "http://www.daisy.org/z3986/2005/ncx/",
      "meta"
    );
    uidMeta.setAttribute("name", "dtb:uid");
    uidMeta.setAttribute("content", "" + BIF.map["-odread-buid"]);
    head.appendChild(uidMeta);

    // Step 4: Create docTitle and add text
    const docTitle = doc.createElementNS(
      "http://www.daisy.org/z3986/2005/ncx/",
      "docTitle"
    );
    ncxElement.appendChild(docTitle);

    const textElement = doc.createElementNS(
      "http://www.daisy.org/z3986/2005/ncx/",
      "text"
    );
    textElement.textContent = BIF.map.title.main;
    docTitle.appendChild(textElement);

    // Step 5: Create navMap and append navPoint elements
    const navMap = doc.createElementNS(
      "http://www.daisy.org/z3986/2005/ncx/",
      "navMap"
    );
    ncxElement.appendChild(navMap);

    let components = getBookComponents();

    components.forEach((chapter) => {
      // First navPoint
      const navPoint1 = doc.createElementNS(
        "http://www.daisy.org/z3986/2005/ncx/",
        "navPoint"
      );
      navPoint1.setAttribute("id", chapter.meta.id);
      navPoint1.setAttribute("playOrder", "" + (1 + chapter.index));
      navMap.appendChild(navPoint1);

      const navLabel1 = doc.createElementNS(
        "http://www.daisy.org/z3986/2005/ncx/",
        "navLabel"
      );
      navPoint1.appendChild(navLabel1);

      const text1 = doc.createElementNS(
        "http://www.daisy.org/z3986/2005/ncx/",
        "text"
      );
      text1.textContent = BIF.map.title.main;
      navLabel1.appendChild(text1);

      const content1 = doc.createElementNS(
        "http://www.daisy.org/z3986/2005/ncx/",
        "content"
      );
      content1.setAttribute("src", truncate(chapter.meta.path));
      navPoint1.appendChild(content1);
    });

    // Step 6: Serialize the document to a string
    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(doc);

    oebps.file(
      "toc.ncx",
      `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
    );
  }
  async function downloadEPUB() {
    let imageAssets = new Array();

    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.folder("META-INF").file(
      "container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>
    `
    );

    let oebps = zip.folder("OEBPS");
    await createContent(oebps, imageAssets);

    makePackage(oebps, imageAssets);
    makeToc(oebps);

    downloadElem.innerHTML +=
      "<br><b>Downloads complete!</b> Now waiting for them to be assembled! (This might take a <b><i>minute</i></b>) <br>";
    downloadElem.innerHTML += "Zip progress: <b id='zipProg'>0</b>%<br>";

    // Generate the zip file
    const zipBlob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        streamFiles: true,
      },
      (meta) => {
        if (meta.percent)
          downloadElem.querySelector("#zipProg").textContent =
            meta.percent.toFixed(2);
      }
    );

    downloadElem.innerHTML += `EPUB generation complete! Starting download<br>`;
    downloadElem.scrollTo(0, downloadElem.scrollHeight);

    const downloadUrl = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    const bookMetadata = getMetadata();
    const formattedTitle = formatTitleWithArticle(bookMetadata.title);
    const titlePart =
      formattedTitle +
      (bookMetadata.subtitle ? " - " + bookMetadata.subtitle : "");
    const authorPart = "[" + getAuthorString() + "]";
    link.download = titlePart + " " + authorPart + ".epub";
    link.click();

    // Clean up the object URL
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);

    downloadState = -1;
  }

  // Main entry point for audiobooks
  function bifFoundBook() {
    // New global style info
    let s = document.createElement("style");
    s.innerHTML = CSS;
    document.head.appendChild(s);

    if (!window.__bif_cfc1) {
      alert("Injection failed! __bif_cfc1 not found");
      return;
    }
    const old_crf1 = window.__bif_cfc1;
    window.__bif_cfc1 = (win, edata) => {
      // If the bind hook succeeds, then the first element of bound args
      // will be the decryption function. So we just passivly build up an
      // index of the pages!
      pages[win.name] = old_crf1.__boundArgs[0](edata);
      return old_crf1(win, edata);
    };

    buildBookLibreUi();
  }

  function downloadEPUBBBtn() {
    if (downloadState != -1) return;

    downloadState = 0;
    downloadElem.classList.add("active");
    downloadElem.innerHTML = "<b>Starting download</b><br>";

    downloadEPUB().then(() => {});
  }
  function buildBookLibreUi() {
    // Create the nav
    let nav = document.createElement("div");
    nav.innerHTML = bookNav;
    nav.querySelector("#download").onclick = downloadEPUBBBtn;
    nav.classList.add("pNav");
    let pbar = document.querySelector(".nav-progress-bar");
    pbar.insertBefore(nav, pbar.children[1]);

    downloadElem = document.createElement("div");
    downloadElem.classList.add("foldMenu");
    downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
    document.body.appendChild(downloadElem);
  }

  /* =========================================
        END BOOK SECTION!
     =========================================
  */

  /* =========================================
        BEGIN INITIALIZER SECTION!
     =========================================
  */

  // The "BIF" contains all the info we need to download
  // stuff, so we wait until the page is loaded, and the
  // BIF is present, to inject the Libre menu.
  let intr = setInterval(() => {
    if (
      window.BIF != undefined &&
      document.querySelector(".nav-progress-bar") != undefined
    ) {
      clearInterval(intr);
      let mode = location.hostname.split(".")[1];
      if (mode == "listen") {
        bifFoundAudiobook();
      } else if (mode == "read") {
        bifFoundBook();
      }
    }
  }, 25);
})();
