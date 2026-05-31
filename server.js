const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["teacher", "student"], required: true },
  groupName: { type: String, default: "" },
  fullName: { type: String, default: "" }
});

const User = mongoose.model("User", userSchema);

const stateSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  data: { type: Object, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const AppState = mongoose.model("AppState", stateSchema);

const activitySchema = new mongoose.Schema({
  createdAt: { type: Date, default: Date.now },
  username: { type: String, default: "" },
  role: { type: String, default: "" },
  action: { type: String, required: true },
  details: { type: String, default: "" }
});

const Activity = mongoose.model("Activity", activitySchema);

const homeworkSchema = new mongoose.Schema({
  subjectName: { type: String, required: true },
  groupName: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  dueDate: { type: String, default: "" },
  links: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Homework = mongoose.model("Homework", homeworkSchema);


async function addActivity(user, action, details) {
  try {
    await Activity.create({
      username: user && user.username ? user.username : "system",
      role: user && user.role ? user.role : "system",
      action: String(action || "Действие"),
      details: String(details || "")
    });

    const count = await Activity.countDocuments();
    if (count > 500) {
      const old = await Activity.find().sort({ createdAt: 1 }).limit(count - 500).select("_id");
      await Activity.deleteMany({ _id: { $in: old.map(x => x._id) } });
    }
  } catch (e) {
    console.log("Не удалось записать историю:", e.message);
  }
}

const TEACHER_USERNAME = process.env.TEACHER_LOGIN || "Учитель";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD;
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 60 * 1000;

function getLoginKey(req, username) {
  return String(username || "").trim().toLowerCase() + "|" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local");
}

function isLoginBlocked(key) {
  const item = loginAttempts.get(key);
  if (!item) return 0;
  if (item.blockUntil && item.blockUntil > Date.now()) return Math.ceil((item.blockUntil - Date.now()) / 1000);
  if (item.blockUntil && item.blockUntil <= Date.now()) loginAttempts.delete(key);
  return 0;
}

function registerLoginFailure(key) {
  const item = loginAttempts.get(key) || { count: 0, blockUntil: 0 };
  item.count += 1;
  if (item.count >= MAX_LOGIN_ATTEMPTS) {
    item.blockUntil = Date.now() + LOGIN_BLOCK_MS;
    item.count = 0;
  }
  loginAttempts.set(key, item);
}


async function ensureTeacherAccount() {
  if (!TEACHER_PASSWORD) {
    throw new Error("TEACHER_PASSWORD не задан в переменных окружения");
  }

  const existing = await User.findOne({ username: TEACHER_USERNAME, role: "teacher" });

  if (!existing) {
    await User.create({
      username: TEACHER_USERNAME,
      passwordHash: await bcrypt.hash(TEACHER_PASSWORD, 10),
      role: "teacher",
      groupName: "",
      fullName: "Учитель"
    });
  } else {
    existing.groupName = "";
    existing.fullName = "Учитель";
    await existing.save();
  }

  // Старый демо-логин больше не нужен. Если он есть, удаляем его.
  await User.deleteOne({ username: "teacher", role: "teacher" });
}

function makeId(text) {
  text = String(text || "empty");
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return "id_" + Math.abs(h) + "_" + text.replace(/[^a-zA-Z0-9а-яА-ЯёЁ]/g, "_").slice(0, 24);
}

function defaultJournalData() {
  return {
    subjects: [],
    scale: "2-5"
  };
}

async function ensureState() {
  let state = await AppState.findOne({ key: "main" });
  if (!state) {
    state = await AppState.create({ key: "main", data: defaultJournalData(), updatedAt: new Date() });
  }
  return state;
}

function filterDataForStudent(data, user) {
  const copy = { subjects: [], scale: data.scale || "2-5" };
  const targetGroup = user.groupName;

  (data.subjects || []).forEach(subject => {
    const newSubject = { ...subject, groups: [] };

    (subject.groups || []).forEach(group => {
      if (targetGroup && group.name !== targetGroup) return;

      const newGroup = {
        ...group,
        notes: {}
      };

      newSubject.groups.push(newGroup);
    });

    if (newSubject.groups.length) copy.subjects.push(newSubject);
  });

  return copy;
}

app.get("/api/test", (req, res) => {
  res.json({ message: "Сервер работает и MongoDB подключена" });
});

app.post("/api/setup", async (req, res) => {
  try {
    await ensureTeacherAccount();
    await ensureState();
    res.json({ message: "Учётная запись учителя готова" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка подготовки системы", error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const loginKey = getLoginKey(req, username);
    const wait = isLoginBlocked(loginKey);
    if (wait > 0) {
      return res.status(429).json({ message: `Слишком много попыток входа. Попробуйте через ${wait} сек.` });
    }

    const user = await User.findOne({ username });
    if (!user) {
      registerLoginFailure(loginKey);
      return res.status(401).json({ message: "Пользователь не найден" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      registerLoginFailure(loginKey);
      return res.status(401).json({ message: "Неверный пароль" });
    }

    loginAttempts.delete(loginKey);

    res.json({
      message: "Вход выполнен",
      user: {
        username: user.username,
        role: user.role,
        groupName: user.groupName,
        fullName: user.fullName
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Ошибка входа", error: error.message });
  }
});

app.post("/api/teacher-password", async (req, res) => {
  try {
    const { user, oldPassword, newPassword } = req.body || {};

    if (!user || user.role !== "teacher") {
      return res.status(403).json({ message: "Менять пароль может только учитель" });
    }

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: "Введите старый и новый пароль" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "Новый пароль должен быть минимум 6 символов" });
    }

    const teacher = await User.findOne({ username: user.username, role: "teacher" });
    if (!teacher) return res.status(404).json({ message: "Учитель не найден" });

    const ok = await bcrypt.compare(String(oldPassword), teacher.passwordHash);
    if (!ok) return res.status(401).json({ message: "Старый пароль неверный" });

    teacher.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await teacher.save();
    await addActivity(user, "Изменён пароль учителя", "Пароль учителя изменён через настройки");

    res.json({ message: "Пароль учителя изменён" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка смены пароля", error: error.message });
  }
});

app.post("/api/group-users", async (req, res) => {
  try {
    const user = req.body.user || {};

    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Список доступов может смотреть только учитель" });
    }

    const users = await User.find({ role: "student" })
      .select("username groupName fullName -_id")
      .sort({ groupName: 1, username: 1 });

    res.json({ users });
  } catch (error) {
    res.status(500).json({
      message: "Ошибка получения доступов",
      error: error.message
    });
  }
});

app.post("/api/group-user", async (req, res) => {
  try {
    const { user, username, password, groupName } = req.body || {};

    if (!user || user.role !== "teacher") {
      return res.status(403).json({ message: "Создавать доступ может только учитель" });
    }

    if (!username || !groupName) {
      return res.status(400).json({ message: "Нужны логин и группа" });
    }

    const update = {
      username: String(username).trim(),
      role: "student",
      groupName: String(groupName).trim(),
      fullName: "Группа " + String(groupName).trim() + " (все предметы)"
    };

    if (password) {
      update.passwordHash = await bcrypt.hash(String(password), 10);
    }

    const exists = await User.findOne({ username: update.username });
    if (exists && exists.role === "teacher") {
      return res.status(400).json({ message: "Нельзя заменить логин учителя" });
    }

    if (!exists && !password) {
      return res.status(400).json({ message: "Для нового логина нужен пароль" });
    }

    await User.findOneAndUpdate(
      { username: update.username },
      update,
      { upsert: true, new: true }
    );

    await addActivity(user, "Доступ группы", "Логин " + update.username + " привязан к группе " + update.groupName);
    res.json({ message: "Доступ для группы сохранён. Этот логин работает для всех предметов, где есть эта группа." });
  } catch (error) {
    res.status(500).json({
      message: "Ошибка сохранения доступа",
      error: error.message
    });
  }
});


app.post("/api/group-user-delete", async (req, res) => {
  try {
    const { user, username } = req.body || {};

    if (!user || user.role !== "teacher") {
      return res.status(403).json({ message: "Удалять доступ может только учитель" });
    }

    if (!username) {
      return res.status(400).json({ message: "Не указан логин для удаления" });
    }

    if (username === "teacher") {
      return res.status(400).json({ message: "Нельзя удалить логин учителя" });
    }

    const deleted = await User.findOneAndDelete({ username: String(username).trim(), role: "student" });

    if (!deleted) {
      return res.status(404).json({ message: "Такой групповой доступ не найден" });
    }

    await addActivity(user, "Удалён доступ", "Логин " + username + " удалён");
    res.json({ message: "Доступ удалён" });
  } catch (error) {
    res.status(500).json({
      message: "Ошибка удаления доступа",
      error: error.message
    });
  }
});



// Совместимый маршрут удаления через DELETE, если фронтенд или браузер отправит DELETE вместо POST.
app.delete("/api/group-access/:username", async (req, res) => {
  try {
    const username = req.params.username;

    // Для DELETE часть браузеров/фронтендов передаёт user в body.
    const { user } = req.body || {};

    if (!user || user.role !== "teacher") {
      return res.status(403).json({ message: "Удалять доступ может только учитель" });
    }

    if (!username) {
      return res.status(400).json({ message: "Не указан логин для удаления" });
    }

    if (username === "teacher") {
      return res.status(400).json({ message: "Нельзя удалить логин учителя" });
    }

    const deleted = await User.findOneAndDelete({ username: String(username).trim(), role: "student" });

    if (!deleted) {
      return res.status(404).json({ message: "Такой групповой доступ не найден" });
    }

    await addActivity(user, "Удалён доступ", "Логин " + username + " удалён");
    res.json({ message: "Доступ удалён" });
  } catch (error) {
    res.status(500).json({
      message: "Ошибка удаления доступа",
      error: error.message
    });
  }
});

app.post("/api/state", async (req, res) => {
  try {
    // Сохранение данных. Разрешено только учителю.
    if (req.body && req.body.data) {
      const user = req.body.user || {};
      if (user.role !== "teacher") {
        return res.status(403).json({ message: "Сохранять данные может только учитель" });
      }

      await AppState.findOneAndUpdate(
        { key: "main" },
        { key: "main", data: req.body.data, updatedAt: new Date() },
        { upsert: true, new: true }
      );

      return res.json({ message: "Данные сохранены" });
    }

    // Загрузка данных.
    const state = await ensureState();
    const user = req.body || {};

    if (user.role === "student") {
      return res.json({ data: filterDataForStudent(state.data, user) });
    }

    res.json({ data: state.data });
  } catch (error) {
    res.status(500).json({ message: "Ошибка работы с журналом", error: error.message });
  }
});


app.post("/api/backup/export", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Резервную копию может скачать только учитель" });
    }

    const state = await ensureState();
    const groupUsers = await User.find({ role: "student" })
      .select("username groupName fullName -_id")
      .sort({ groupName: 1, username: 1 });

    const homework = await Homework.find()
      .sort({ dueDate: 1, subjectName: 1, groupName: 1 })
      .lean();

    res.json({
      version: 3,
      exportedAt: new Date().toISOString(),
      data: state.data,
      groupUsers,
      homework
    });
  } catch (error) {
    res.status(500).json({ message: "Ошибка создания резервной копии", error: error.message });
  }
});

app.post("/api/backup/import", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Резервную копию может восстановить только учитель" });
    }

    const backup = req.body.backup || {};
    const importedData = backup.data || backup;

    if (!importedData || !Array.isArray(importedData.subjects)) {
      return res.status(400).json({ message: "Файл резервной копии не похож на журнал" });
    }

    await AppState.findOneAndUpdate(
      { key: "main" },
      { key: "main", data: importedData, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    if (Array.isArray(backup.homework)) {
      await Homework.deleteMany({});
      const cleanHomework = backup.homework.map(item => ({
        subjectName: String(item.subjectName || ""),
        groupName: String(item.groupName || ""),
        title: String(item.title || ""),
        description: String(item.description || ""),
        dueDate: String(item.dueDate || ""),
        links: String(item.links || ""),
        createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
        updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date()
      })).filter(item => item.subjectName && item.groupName && item.title);
      if (cleanHomework.length) await Homework.insertMany(cleanHomework);
    }

    await addActivity(user, "Восстановлена резервная копия", "Журнал и домашние задания заменены данными из файла");
    res.json({ message: "Резервная копия восстановлена" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка восстановления резервной копии", error: error.message });
  }
});


app.post("/api/activity-list", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Историю может смотреть только учитель" });
    }

    const items = await Activity.find({ action: { $ne: "Сохранение журнала" } }).sort({ createdAt: -1 }).limit(120).lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: "Ошибка загрузки истории", error: error.message });
  }
});

app.post("/api/activity-add", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Историю может записывать только учитель" });
    }
    await addActivity(user, req.body.action || "Действие", req.body.details || "");
    res.json({ message: "Записано" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка записи истории", error: error.message });
  }
});


app.post("/api/homework-list", async (req, res) => {
  try {
    const user = req.body.user || {};
    const filter = {};

    if (user.role === "student") {
      if (!user.groupName) return res.json({ items: [] });
      filter.groupName = user.groupName;
    } else if (user.role !== "teacher") {
      return res.status(403).json({ message: "Нет доступа к домашним заданиям" });
    }

    if (req.body.subjectName) filter.subjectName = String(req.body.subjectName).trim();
    if (req.body.groupName && user.role === "teacher") filter.groupName = String(req.body.groupName).trim();

    const items = await Homework.find(filter)
      .sort({ dueDate: 1, subjectName: 1, groupName: 1, createdAt: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: "Ошибка загрузки домашнего задания", error: error.message });
  }
});

app.post("/api/homework-save", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Добавлять домашнее задание может только учитель" });
    }

    const subjectName = String(req.body.subjectName || "").trim().slice(0, 120);
    const groupName = String(req.body.groupName || "").trim().slice(0, 120);
    const title = String(req.body.title || "").trim().slice(0, 160);
    const description = String(req.body.description || "").trim().slice(0, 5000);
    const dueDate = String(req.body.dueDate || "").trim().slice(0, 20);
    const links = String(req.body.links || "").trim().slice(0, 3000);

    if (!subjectName || !groupName || !title) {
      return res.status(400).json({ message: "Заполните предмет, группу и название задания" });
    }

    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ message: "Некорректная дата сдачи" });
    }

    const payload = { subjectName, groupName, title, description, dueDate, links, updatedAt: new Date() };

    let item;
    const id = String(req.body.id || "").trim();
    if (id) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Некорректный ID задания" });
      }
      item = await Homework.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
      if (!item) return res.status(404).json({ message: "Задание не найдено" });
      await addActivity(user, "Обновлено ДЗ", subjectName + " / " + groupName + ": " + title);
      return res.json({ message: "Домашнее задание обновлено", item });
    }

    item = await Homework.create(payload);
    await addActivity(user, "Добавлено ДЗ", subjectName + " / " + groupName + ": " + title);
    res.json({ message: "Домашнее задание добавлено", item });
  } catch (error) {
    res.status(500).json({ message: "Ошибка сохранения домашнего задания", error: error.message });
  }
});

app.post("/api/homework-delete", async (req, res) => {
  try {
    const user = req.body.user || {};
    if (user.role !== "teacher") {
      return res.status(403).json({ message: "Удалять домашнее задание может только учитель" });
    }

    const id = String(req.body.id || "").trim();
    if (!id) return res.status(400).json({ message: "Не указан ID задания" });
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Некорректный ID задания" });
    }

    const item = await Homework.findByIdAndDelete(id);
    if (!item) return res.status(404).json({ message: "Задание не найдено" });

    await addActivity(user, "Удалено ДЗ", item.subjectName + " / " + item.groupName + ": " + item.title);
    res.json({ message: "Домашнее задание удалено" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка удаления домашнего задания", error: error.message });
  }
});

async function start() {
  try {
    console.log("Пробую подключиться к MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log("MongoDB подключена");
    await ensureTeacherAccount();
    await ensureState();
    app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
  } catch (err) {
    console.log("Ошибка подключения MongoDB:");
    console.log(err.message);
    process.exit(1);
  }
}

start();
