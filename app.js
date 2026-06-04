(() => {
  class StereoVUMeterApp {
    constructor() {
      this.canvas = document.getElementById("meterCanvas");
      this.ctx = this.canvas.getContext("2d");

      this.powerBtn = document.getElementById("powerBtn");
      this.powerLed = document.getElementById("powerLed");
      this.sourceSelect = document.getElementById("sourceSelect");
      this.fileWrap = document.getElementById("fileWrap");
      this.fileListWrap = document.getElementById("fileListWrap");
      this.audioFile = document.getElementById("audioFile");
      this.audioFileList = document.getElementById("audioFileList");
      this.playPauseBtn = document.getElementById("playPauseBtn");
      this.sensitivitySlider = document.getElementById("sensitivity");
      this.inertiaSlider = document.getElementById("inertia");
      this.holdModeCheck = document.getElementById("holdMode");
      this.statusText = document.getElementById("statusText");
      this.audioEl = document.getElementById("audioEl");

      this.audioCtx = null;
      this.sourceNode = null;
      this.stream = null;
      this.demoNodes = null;
      this.splitter = null;
      this.analysers = [null, null];
      this.buffers = [new Float32Array(2048), new Float32Array(2048)];
      this.audioFiles = [];
      this.currentFileIndex = 0;
      this.audioObjectUrl = null;

      this.isPowered = false;
      this.isPlayingFile = false;
      this.vuEnabled = true;
      this.needleInertia = parseFloat(this.inertiaSlider.value);

      this.vuLeft = 0;
      this.vuRight = 0;
      this.displayLeft = 0;
      this.displayRight = 0;

      this.lastTs = 0;

      this.bindEvents();
      this.resizeCanvas();
      this.animate = this.animate.bind(this);
      requestAnimationFrame(this.animate);
    }

    bindEvents() {
      this.powerBtn.addEventListener("click", () => this.togglePower());
      this.sourceSelect.addEventListener("change", () => this.handleSourceChange());
      this.audioFile.addEventListener("change", () => this.loadAudioFile());
      this.audioFileList.addEventListener("change", async () => this.handleAudioFileSelection());
      this.playPauseBtn.addEventListener("click", () => this.togglePlayPause());
      this.inertiaSlider.addEventListener("input", () => {
        this.needleInertia = parseFloat(this.inertiaSlider.value);
      });
      window.addEventListener("resize", () => this.resizeCanvas());
      this.audioEl.addEventListener("ended", () => {
        this.isPlayingFile = false;
        this.playPauseBtn.textContent = "Play";
      });
    }

    async ensureAudioContext() {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === "suspended") {
        await this.audioCtx.resume();
      }
    }

    setStatus(message) {
      this.statusText.textContent = message;
    }

    setPowerLedHot(on) {
      this.powerLed.classList.toggle("hot", on);
    }

    mapVuResponse(value) {
      const deadZone = 0.005;
      if (value <= deadZone) return 0;

      const lowBoostThreshold = 0.25;
      if (value < lowBoostThreshold) {
        const normalized = (value - deadZone) / (lowBoostThreshold - deadZone);
        const boosted = Math.pow(Math.max(0, normalized), 0.5) * lowBoostThreshold;
        return Math.max(0.01, Math.min(lowBoostThreshold, boosted));
      }

      const midBoostThreshold = 0.85;
      if (value < midBoostThreshold) {
        return Math.min(1, Math.pow(value, 0.85));
      }

      return Math.min(1, value);
    }

    computeNeedleAngle(level) {
      return 129 - level * 78;
    }

    computeRms(analyser, buffer) {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const v = buffer[i];
        sum += v * v;
      }
      return Math.sqrt(sum / buffer.length);
    }

    async togglePower() {
      this.isPowered = !this.isPowered;
      this.powerBtn.classList.toggle("on", this.isPowered);
      this.powerBtn.classList.toggle("off", !this.isPowered);
      this.powerBtn.textContent = this.isPowered ? "POWER ON" : "POWER OFF";

      if (!this.isPowered) {
        await this.stopAllAudio();
        this.playPauseBtn.disabled = true;
        this.setStatus("POWER OFF");
        return;
      }

      await this.ensureAudioContext();
      this.setStatus("Power is on. Choose a source.");
      await this.handleSourceChange();
    }

    async stopAllAudio() {
      if (this.audioEl && !this.audioEl.paused) {
        this.audioEl.pause();
      }
      this.isPlayingFile = false;
      this.playPauseBtn.textContent = "Play";

      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }

      if (this.demoNodes) {
        try {
          this.demoNodes.osc.disconnect();
          this.demoNodes.gain.disconnect();
          this.demoNodes.lfo.disconnect();
          this.demoNodes.lfoGain.disconnect();
          this.demoNodes.osc.stop();
          this.demoNodes.lfo.stop();
        } catch (err) {
          // Ignore stop/disconnect races.
        }
        this.demoNodes = null;
      }

      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (err) {
          // Ignore disconnect errors.
        }
        this.sourceNode = null;
      }

      this.splitter = null;
      this.analysers = [null, null];
    }

    async handleSourceChange() {
      this.fileWrap.classList.toggle("hidden", this.sourceSelect.value !== "file");
      this.fileListWrap.classList.toggle("hidden", this.sourceSelect.value !== "file" || !this.audioFiles.length);
      if (!this.isPowered) return;

      await this.ensureAudioContext();
      await this.stopAllAudio();

      const source = this.sourceSelect.value;
      if (source === "mic") {
        await this.setupMicSource();
      } else if (source === "system") {
        await this.setupSystemAudioSource();
      } else if (source === "file") {
        await this.setupFileSource();
      } else {
        await this.setupDemoSource();
      }
    }

    buildStereoAnalyserChain(sourceNode, outputNode = null, mirrorMonoToRight = false) {
      const splitter = this.audioCtx.createChannelSplitter(2);
      const analyserL = this.audioCtx.createAnalyser();
      const analyserR = this.audioCtx.createAnalyser();
      analyserL.fftSize = 2048;
      analyserR.fftSize = 2048;
      analyserL.smoothingTimeConstant = 0.15;
      analyserR.smoothingTimeConstant = 0.15;

      sourceNode.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      if (mirrorMonoToRight) {
        splitter.connect(analyserR, 0);
      }

      if (outputNode) {
        sourceNode.connect(outputNode);
      }

      this.splitter = splitter;
      this.analysers = [analyserL, analyserR];
    }

    async setupMicSource() {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        const micNode = this.audioCtx.createMediaStreamSource(this.stream);
        this.sourceNode = micNode;
        this.buildStereoAnalyserChain(micNode);
        this.playPauseBtn.disabled = true;
        this.setStatus("Microphone input is active.");
      } catch (err) {
        this.setStatus(`Microphone access failed: ${err.message}`);
      }
    }

    async setupFileSource() {
      if (!this.audioEl.src) {
        this.setStatus("Select an audio file first.");
        return;
      }

      if (!this.mediaElementNode) {
        this.mediaElementNode = this.audioCtx.createMediaElementSource(this.audioEl);
      }
      this.sourceNode = this.mediaElementNode;
      this.buildStereoAnalyserChain(this.mediaElementNode, this.audioCtx.destination);

      this.playPauseBtn.disabled = false;
      this.playPauseBtn.textContent = this.isPlayingFile ? "Pause" : "Play";
      this.setStatus("Audio file mode is ready.");
    }

    async setupSystemAudioSource() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        this.setStatus("System audio capture is not supported in this browser.");
        return;
      }

      try {
        let displayStream;
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
        } catch (firstErr) {
          displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        }

        this.stream = displayStream;
        const systemNode = this.audioCtx.createMediaStreamSource(this.stream);
        this.sourceNode = systemNode;
        this.buildStereoAnalyserChain(systemNode, null, true);

        this.playPauseBtn.disabled = true;
        this.setStatus("System audio capture is active. 화면/탭 공유에서 오디오를 선택하세요.");
      } catch (err) {
        this.setStatus(`System audio capture failed: ${err.message}`);
      }
    }

    async handleAudioFileSelection() {
      const index = this.audioFileList.selectedIndex;
      if (index < 0 || index >= this.audioFiles.length) return;
      await this.setAudioFile(index);
    }

    updateAudioFileList() {
      this.audioFileList.innerHTML = "";
      this.audioFiles.forEach((file, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = file.name;
        this.audioFileList.appendChild(option);
      });
      if (this.audioFiles.length > 0) {
        this.audioFileList.selectedIndex = this.currentFileIndex;
      }
    }

    async setAudioFile(index) {
      const file = this.audioFiles[index];
      if (!file) return;

      if (this.audioObjectUrl) {
        URL.revokeObjectURL(this.audioObjectUrl);
      }
      this.audioObjectUrl = URL.createObjectURL(file);
      this.audioEl.src = this.audioObjectUrl;
      this.currentFileIndex = index;
      this.audioFileList.selectedIndex = index;
      this.isPlayingFile = false;
      this.playPauseBtn.textContent = "Play";
      this.setStatus(`Loaded ${this.audioFiles.length} file(s). Selected: ${file.name}`);

      if (this.isPowered && this.sourceSelect.value === "file") {
        await this.setupFileSource();
      }
    }

    async loadAudioFile() {
      const files = this.audioFile.files ? Array.from(this.audioFile.files) : [];
      if (!files.length) return;

      this.audioFiles = files;
      this.currentFileIndex = 0;
      this.updateAudioFileList();
      await this.setAudioFile(0);

      if (this.audioFiles.length > 1) {
        this.setStatus(`Loaded ${this.audioFiles.length} files. 첫 번째 파일이 자동 선택되었습니다.`);
      }
    }

    async setupDemoSource() {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      const lfo = this.audioCtx.createOscillator();
      const lfoGain = this.audioCtx.createGain();
      const panner = this.audioCtx.createStereoPanner();

      osc.type = "sawtooth";
      osc.frequency.value = 120;
      gain.gain.value = 0.08;

      lfo.type = "sine";
      lfo.frequency.value = 1.8;
      lfoGain.gain.value = 0.08;

      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);

      osc.connect(panner);
      panner.pan.value = 0;
      panner.connect(gain);
      gain.connect(this.audioCtx.destination);

      this.sourceNode = gain;
      this.buildStereoAnalyserChain(gain);

      osc.start();
      lfo.start();
      this.demoNodes = { osc, gain, lfo, lfoGain };

      this.playPauseBtn.disabled = true;
      this.setStatus("Demo tone is playing.");
    }

    togglePlayPause() {
      if (this.sourceSelect.value !== "file") return;
      if (!this.audioEl.src) {
        this.setStatus("Select an audio file first.");
        return;
      }

      if (this.audioEl.paused) {
        this.audioEl.play();
        this.isPlayingFile = true;
        this.playPauseBtn.textContent = "Pause";
        this.setStatus("File is playing.");
      } else {
        this.audioEl.pause();
        this.isPlayingFile = false;
        this.playPauseBtn.textContent = "Play";
        this.setStatus("File is paused.");
      }
    }

    updateLevels() {
      if (!this.isPowered || !this.vuEnabled) {
        this.vuLeft *= 0.92;
        this.vuRight *= 0.92;
        this.displayLeft += (this.vuLeft - this.displayLeft) * this.needleInertia;
        this.displayRight += (this.vuRight - this.displayRight) * this.needleInertia;
        return;
      }

      const sensitivity = parseFloat(this.sensitivitySlider.value);
      const rawLeft = this.computeRms(this.analysers[0], this.buffers[0]);
      const rawRight = this.computeRms(this.analysers[1], this.buffers[1]);

      this.vuLeft = this.mapVuResponse(Math.min(1, rawLeft * sensitivity));
      this.vuRight = this.mapVuResponse(Math.min(1, rawRight * sensitivity));

      const holdMode = this.holdModeCheck.checked;
      if (holdMode) {
        if (this.vuLeft > this.displayLeft) {
          this.displayLeft += (this.vuLeft - this.displayLeft) * this.needleInertia;
        }
        if (this.vuRight > this.displayRight) {
          this.displayRight += (this.vuRight - this.displayRight) * this.needleInertia;
        }
      } else {
        this.displayLeft += (this.vuLeft - this.displayLeft) * this.needleInertia;
        this.displayRight += (this.vuRight - this.displayRight) * this.needleInertia;
      }

      this.displayLeft = Math.max(0, Math.min(1, this.displayLeft));
      this.displayRight = Math.max(0, Math.min(1, this.displayRight));
    }

    resizeCanvas() {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.floor(width * 0.25);
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    drawGauge(cx, cy, radius, level, label) {
      const ctx = this.ctx;

      ctx.save();
      ctx.translate(cx, cy);

      ctx.strokeStyle = "#1e2d38";
      ctx.lineWidth = 2;
      // Draw only the active scale span: -20 to +3 (129deg -> 51deg).
      const startDeg = 129;
      const endDeg = 51;
      const steps = 48;
      ctx.beginPath();
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const angDeg = startDeg + (endDeg - startDeg) * t;
        const ang = (angDeg * Math.PI) / 180;
        const x = Math.cos(ang) * radius;
        const y = -Math.sin(ang) * radius;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      const marks = [
        { t: 0.0, text: "-20" },
        { t: 0.28, text: "-10" },
        { t: 0.52, text: "-3" },
        { t: 0.72, text: "0" },
        { t: 1.0, text: "+3" }
      ];

      for (let i = 0; i <= 24; i += 1) {
        const t = i / 24;
        const angDeg = 129 - t * 78;
        const ang = (angDeg * Math.PI) / 180;
        const isMajor = i % 6 === 0;
        const len = isMajor ? 18 : 10;

        const x1 = Math.cos(ang) * (radius - len);
        const y1 = -Math.sin(ang) * (radius - len);
        const x2 = Math.cos(ang) * radius;
        const y2 = -Math.sin(ang) * radius;

        ctx.strokeStyle = "#10202d";
        ctx.lineWidth = isMajor ? 2.2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.fillStyle = "#0f2a3d";
      ctx.font = "bold 16px Trebuchet MS, Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("DECIBELS", 0, -radius * 0.58);

      ctx.font = "14px Trebuchet MS, Segoe UI, sans-serif";
      marks.forEach((m) => {
        const angDeg = 129 - m.t * 78;
        const ang = (angDeg * Math.PI) / 180;
        const tx = Math.cos(ang) * (radius + 18);
        const ty = -Math.sin(ang) * (radius + 18);
        let dx = 0;
        if (m.text === "-10") dx = -8;
        if (m.text === "-3") dx = -6;
        if (m.text === "0") dx = 6;
        ctx.fillText(m.text, tx + dx, ty + 5);
      });

      const needleAng = (this.computeNeedleAngle(level) * Math.PI) / 180;
      const nx = Math.cos(needleAng) * (radius - 24);
      const ny = -Math.sin(needleAng) * (radius - 24);

      ctx.strokeStyle = "#10161d";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = "#05090f";
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    draw() {
      const ctx = this.ctx;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;

      ctx.clearRect(0, 0, w, h);

      const panelGrad = ctx.createLinearGradient(0, 0, 0, h);
      panelGrad.addColorStop(0, "#00b2fc");
      panelGrad.addColorStop(1, "#009bf4");
      ctx.fillStyle = panelGrad;
      ctx.fillRect(0, 0, w, h);

      const cxLeft = w * 0.28;
      const cxRight = w * 0.72;
      const cy = h * 1.3;
      const radius = Math.min(w * 1, h * 1);

      this.drawGauge(cxLeft, cy, radius, this.displayLeft, "LEFT");
      this.drawGauge(cxRight, cy, radius, this.displayRight, "RIGHT");

      // Mask the lower zone with the same background tone.
      const maskTop = h * 1;
      const maskGrad = ctx.createLinearGradient(0, maskTop, 0, h);
      maskGrad.addColorStop(0, "#84bdd4");
      maskGrad.addColorStop(1, "#78b3cb");
      ctx.fillStyle = maskGrad;
      ctx.fillRect(0, maskTop, w, h - maskTop);

      this.setPowerLedHot(this.isPowered);
    }

    animate(ts) {
      if (!this.lastTs) this.lastTs = ts;
      const dt = ts - this.lastTs;
      this.lastTs = ts;

      if (dt > 0) {
        this.updateLevels();
        this.draw();
      }

      requestAnimationFrame(this.animate);
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    new StereoVUMeterApp();
  });
})();
