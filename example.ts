// ============================================================
// Example TypeScript Application - Task Management System
// ============================================================

// Types and Interfaces
interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  createdAt: Date;
  updatedAt: Date;
  assignee?: string;
  tags: string[];
  subtasks: SubTask[];
}

interface SubTask {
  id: string;
  title: string;
  completed: boolean;
}

type TaskStatus = "todo" | "in_progress" | "review" | "done" | "archived";
type Priority = "low" | "medium" | "high" | "critical";

interface TaskFilter {
  status?: TaskStatus[];
  priority?: Priority[];
  assignee?: string;
  tags?: string[];
  search?: string;
}

interface PaginationOptions {
  page: number;
  pageSize: number;
  sortBy: keyof Task;
  sortOrder: "asc" | "desc";
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Utility Functions
function generateId(): string {
  return Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as T;
  if (Array.isArray(obj)) return obj.map((item) => deepClone(item)) as T;
  const cloned = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

// Event Emitter
type EventHandler<T = unknown> = (data: T) => void;

class EventEmitter {
  private handlers: Map<string, EventHandler[]> = new Map();

  on(event: string, handler: EventHandler): () => void {
    const existing = this.handlers.get(event) || [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return () => this.off(event, handler);
  }

  off(event: string, handler: EventHandler): void {
    const existing = this.handlers.get(event) || [];
    this.handlers.set(
      event,
      existing.filter((h) => h !== handler)
    );
  }

  emit(event: string, data?: unknown): void {
    const handlers = this.handlers.get(event) || [];
    handlers.forEach((handler) => handler(data));
  }

  once(event: string, handler: EventHandler): () => void {
    const wrapper: EventHandler = (data) => {
      handler(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }
}

// Task Store
class TaskStore extends EventEmitter {
  private tasks: Map<string, Task> = new Map();

  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  getById(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  create(input: Omit<Task, "id" | "createdAt" | "updatedAt" | "subtasks">): Task {
    const now = new Date();
    const task: Task = {
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      subtasks: [],
    };
    this.tasks.set(task.id, task);
    this.emit("task:created", task);
    return task;
  }

  update(id: string, updates: Partial<Omit<Task, "id" | "createdAt">>): Task | null {
    const existing = this.tasks.get(id);
    if (!existing) return null;

    const updated: Task = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
    this.tasks.set(id, updated);
    this.emit("task:updated", { previous: existing, current: updated });
    return updated;
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.emit("task:deleted", task);
    return true;
  }

  addSubTask(taskId: string, title: string): SubTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const subtask: SubTask = {
      id: generateId(),
      title,
      completed: false,
    };
    task.subtasks.push(subtask);
    task.updatedAt = new Date();
    this.emit("task:subtask:added", { taskId, subtask });
    return subtask;
  }

  toggleSubTask(taskId: string, subtaskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const subtask = task.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return false;

    subtask.completed = !subtask.completed;
    task.updatedAt = new Date();
    this.emit("task:subtask:toggled", { taskId, subtask });
    return true;
  }

  filter(criteria: TaskFilter): Task[] {
    let results = this.getAll();

    if (criteria.status?.length) {
      results = results.filter((t) => criteria.status!.includes(t.status));
    }
    if (criteria.priority?.length) {
      results = results.filter((t) => criteria.priority!.includes(t.priority));
    }
    if (criteria.assignee) {
      results = results.filter((t) => t.assignee === criteria.assignee);
    }
    if (criteria.tags?.length) {
      results = results.filter((t) =>
        criteria.tags!.some((tag) => t.tags.includes(tag))
      );
    }
    if (criteria.search) {
      const query = criteria.search.toLowerCase();
      results = results.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query)
      );
    }
    return results;
  }

  paginate(options: PaginationOptions, filter?: TaskFilter): PaginatedResult<Task> {
    const filtered = filter ? this.filter(filter) : this.getAll();

    const sorted = [...filtered].sort((a, b) => {
      const aVal = a[options.sortBy];
      const bVal = b[options.sortBy];
      const modifier = options.sortOrder === "asc" ? 1 : -1;

      if (aVal < bVal) return -1 * modifier;
      if (aVal > bVal) return 1 * modifier;
      return 0;
    });

    const start = (options.page - 1) * options.pageSize;
    const items = sorted.slice(start, start + options.pageSize);

    return {
      items,
      total: filtered.length,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: Math.ceil(filtered.length / options.pageSize),
    };
  }

  getStats(): Record<string, number> {
    const tasks = this.getAll();
    return {
      total: tasks.length,
      todo: tasks.filter((t) => t.status === "todo").length,
      inProgress: tasks.filter((t) => t.status === "in_progress").length,
      review: tasks.filter((t) => t.status === "review").length,
      done: tasks.filter((t) => t.status === "done").length,
      archived: tasks.filter((t) => t.status === "archived").length,
      critical: tasks.filter((t) => t.priority === "critical").length,
      high: tasks.filter((t) => t.priority === "high").length,
      medium: tasks.filter((t) => t.priority === "medium").length,
      low: tasks.filter((t) => t.priority === "low").length,
    };
  }
}

// Task Validator
class TaskValidator {
  private errors: string[] = [];

  validate(input: Partial<Task>): { valid: boolean; errors: string[] } {
    this.errors = [];

    if (input.title !== undefined) {
      this.validateTitle(input.title);
    }
    if (input.description !== undefined) {
      this.validateDescription(input.description);
    }
    if (input.tags !== undefined) {
      this.validateTags(input.tags);
    }
    if (input.assignee !== undefined) {
      this.validateAssignee(input.assignee);
    }

    return { valid: this.errors.length === 0, errors: [...this.errors] };
  }

  private validateTitle(title: string): void {
    if (!title.trim()) {
      this.errors.push("Title cannot be empty");
    }
    if (title.length > 200) {
      this.errors.push("Title must be 200 characters or less");
    }
  }

  private validateDescription(description: string): void {
    if (description.length > 5000) {
      this.errors.push("Description must be 5000 characters or less");
    }
  }

  private validateTags(tags: string[]): void {
    if (tags.length > 10) {
      this.errors.push("Maximum 10 tags allowed");
    }
    const invalidTags = tags.filter((t) => t.length > 50 || !t.trim());
    if (invalidTags.length > 0) {
      this.errors.push("Tags must be non-empty and 50 characters or less");
    }
  }

  private validateAssignee(assignee: string): void {
    if (assignee && assignee.length > 100) {
      this.errors.push("Assignee name must be 100 characters or less");
    }
  }
}

// Logger
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix: string, level: LogLevel = LogLevel.INFO) {
    this.prefix = prefix;
    this.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level < this.level) return;
    const timestamp = formatDate(new Date());
    const levelName = LogLevel[level];
    const formatted = `[${timestamp}] [${levelName}] [${this.prefix}] ${message}`;
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formatted, ...args);
        break;
      case LogLevel.INFO:
        console.info(formatted, ...args);
        break;
      case LogLevel.WARN:
        console.warn(formatted, ...args);
        break;
      case LogLevel.ERROR:
        console.error(formatted, ...args);
        break;
    }
  }
}

// Task Service (orchestrates store + validator + logger)
class TaskService {
  private store: TaskStore;
  private validator: TaskValidator;
  private logger: Logger;

  constructor() {
    this.store = new TaskStore();
    this.validator = new TaskValidator();
    this.logger = new Logger("TaskService");
    this.setupListeners();
  }

  private setupListeners(): void {
    this.store.on("task:created", (task) => {
      this.logger.info(`Task created: ${(task as Task).title}`);
    });
    this.store.on("task:updated", (data) => {
      const { current } = data as { previous: Task; current: Task };
      this.logger.info(`Task updated: ${current.title}`);
    });
    this.store.on("task:deleted", (task) => {
      this.logger.info(`Task deleted: ${(task as Task).title}`);
    });
  }

  createTask(input: {
    title: string;
    description: string;
    status: TaskStatus;
    priority: Priority;
    assignee?: string;
    tags: string[];
  }): { success: boolean; task?: Task; errors?: string[] } {
    const validation = this.validator.validate(input);
    if (!validation.valid) {
      this.logger.warn("Validation failed", validation.errors);
      return { success: false, errors: validation.errors };
    }
    const task = this.store.create(input);
    return { success: true, task };
  }

  updateTask(
    id: string,
    updates: Partial<Omit<Task, "id" | "createdAt">>
  ): { success: boolean; task?: Task; errors?: string[] } {
    const validation = this.validator.validate(updates);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }
    const task = this.store.update(id, updates);
    if (!task) {
      return { success: false, errors: ["Task not found"] };
    }
    return { success: true, task };
  }

  deleteTask(id: string): boolean {
    return this.store.delete(id);
  }

  getTask(id: string): Task | undefined {
    return this.store.getById(id);
  }

  listTasks(
    options: PaginationOptions,
    filter?: TaskFilter
  ): PaginatedResult<Task> {
    return this.store.paginate(options, filter);
  }

  addSubTask(taskId: string, title: string): SubTask | null {
    return this.store.addSubTask(taskId, title);
  }

  toggleSubTask(taskId: string, subtaskId: string): boolean {
    return this.store.toggleSubTask(taskId, subtaskId);
  }

  getStats(): Record<string, number> {
    return this.store.getStats();
  }

  exportTasks(): string {
    const tasks = this.store.getAll();
    return JSON.stringify(tasks, null, 2);
  }

  importTasks(json: string): { imported: number; errors: string[] } {
    const errors: string[] = [];
    let imported = 0;

    try {
      const tasks = JSON.parse(json) as Task[];
      if (!Array.isArray(tasks)) {
        return { imported: 0, errors: ["Invalid format: expected array"] };
      }

      for (const task of tasks) {
        const validation = this.validator.validate(task);
        if (validation.valid) {
          this.store.create({
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            assignee: task.assignee,
            tags: task.tags,
          });
          imported++;
        } else {
          errors.push(`Skipped "${task.title}": ${validation.errors.join(", ")}`);
        }
      }
    } catch (e) {
      errors.push(`Parse error: ${(e as Error).message}`);
    }

    this.logger.info(`Import complete: ${imported} tasks imported`);
    return { imported, errors };
  }
}

// Main Application Entry
function main(): void {
  const service = new TaskService();

  const result1 = service.createTask({
    title: "Implement user authentication",
    description: "Add JWT-based auth with refresh tokens",
    status: "in_progress",
    priority: "high",
    assignee: "alice",
    tags: ["backend", "security"],
  });

  const result2 = service.createTask({
    title: "Design landing page",
    description: "Create responsive landing page with hero section",
    status: "todo",
    priority: "medium",
    assignee: "bob",
    tags: ["frontend", "design"],
  });

  const result3 = service.createTask({
    title: "Fix database connection pooling",
    description: "Connection pool exhaustion under high load",
    status: "todo",
    priority: "critical",
    tags: ["backend", "database", "performance"],
  });

  if (result1.task) {
    service.addSubTask(result1.task.id, "Set up JWT library");
    service.addSubTask(result1.task.id, "Create auth middleware");
    service.addSubTask(result1.task.id, "Add refresh token rotation");
  }

  const page = service.listTasks(
    { page: 1, pageSize: 10, sortBy: "priority", sortOrder: "desc" },
    { status: ["todo", "in_progress"] }
  );

  console.log("Tasks:", page.items.length, "of", page.total);
  console.log("Stats:", service.getStats());

  if (result2.task) {
    service.updateTask(result2.task.id, { status: "in_progress" });
  }

  if (result3.task) {
    service.updateTask(result3.task.id, {
      assignee: "charlie",
      status: "in_progress",
    });
  }

  const exported = service.exportTasks();
  console.log("Exported JSON length:", exported.length);
}

main();
