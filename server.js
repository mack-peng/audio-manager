const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const session = require("express-session");

// 初始化Express应用
const publicDir = path.join(__dirname, 'public')
const app = express();
const PORT = 8001;

// 确保上传目录存在
const uploadDir = path.join(__dirname, "uploads");
if (!fsSync.existsSync(uploadDir)) {
  fsSync.mkdirSync(uploadDir);
}

// 配置中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

// 配置会话管理
app.use(
  session({
    secret: "recording-system-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // 开发环境使用false，生产环境应设为true并启用HTTPS
  })
);

// 配置Multer用于文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // 1. 先尝试修复双重编码（如果文件名已经是乱码）
    const fixedName = Buffer.from(file.originalname, "latin1").toString("utf8");
    console.log("Fixed name:", fixedName); // 应该输出正确的中文，如 "测试录音.m4a"

    // 2. 解析文件名和扩展名
    const parsed = path.parse(fixedName);
    const name = parsed.name;
    const ext = parsed.ext;

    // 3. 生成时间戳（格式：YYYYMMDDHHmmss）
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);

    // 4. 新文件名：原始名称-时间戳.扩展名
    const newFilename = `${name}-${timestamp}${ext}`;

    cb(null, newFilename);
  },
});

// 只允许音频文件上传
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "audio/mpeg",
    "audio/wav",
    "audio/mp3",
    "audio/webm",
    "audio/amr",
    "audio/x-m4a",
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("只允许上传音频文件（mp3, wav, webm等）"), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 限制50MB
});

// 写死的账号密码（实际应用中应使用数据库存储加密后的密码）
const VALID_CREDENTIALS = {
  username: "admin",
  password: "123456",
};

// 登录验证中间件
const requireAuth = (req, res, next) => {
  if (req.session && req.session.isAuthenticated) {
    return next();
  }
  res.status(401).json({ message: "需要登录" });
};

// 登录API
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === VALID_CREDENTIALS.username &&
    password === VALID_CREDENTIALS.password
  ) {
    req.session.isAuthenticated = true;
    return res.json({ success: true, message: "登录成功" });
  }

  res.status(401).json({ success: false, message: "用户名或密码错误" });
});

// 登出API
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "登出失败" });
    }
    res.json({ success: true, message: "登出成功" });
  });
});

// 检查登录状态API
app.get("/api/check-auth", (req, res) => {
  if (req.session && req.session.isAuthenticated) {
    return res.json({ isAuthenticated: true });
  }
  res.json({ isAuthenticated: false });
});

// 上传录音文件API
// 最多10个文件
app.post(
  "/api/upload",
  requireAuth,
  upload.array("recordings", 10),
  (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "未上传文件" });
    }

    // 处理多个文件信息
    const uploadedFiles = req.files.map((file) => ({
      message: "文件上传成功",
      filename: file.filename,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      path: file.path,
      uploadedAt: new Date().toISOString(),
    }));

    res.json({
      success: true,
      files: uploadedFiles,
      total: uploadedFiles.length,
    });
  }
);

// 获取录音列表API
app.get("/api/recordings", requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(uploadDir);
    const recordingList = [];

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);

      // 只处理文件，跳过目录
      if (stats.isFile()) {
        recordingList.push({
          filename: file,
          originalname: file.replace(/^recording-\d+-\d+/, "recording"), // 简化显示名称
          size: stats.size,
          uploadedAt: stats.ctime.toISOString(),
          url: `/uploads/${file}`,
        });
      }
    }

    // 按上传时间排序，最新的在前面
    recordingList.sort(
      (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
    );

    res.json(recordingList);
  } catch (err) {
    console.error("获取录音列表失败:", err);
    res.status(500).json({ message: "获取录音列表失败" });
  }
});

// 处理上传文件的访问请求（需登录）
app.get('/uploads/:filename', requireAuth, async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  try {
    // 验证文件是否存在
    await fs.access(filePath);
    // 发送文件给客户端
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ message: '文件不存在' });
  }
});

// 删除录音文件API
app.delete("/api/recordings/:filename", requireAuth, async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    await fs.unlink(filePath);
    res.json({ success: true, message: "录音已删除" });
  } catch (err) {
    console.error("删除录音失败:", err);
    res.status(500).json({ success: false, message: "删除录音失败" });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
