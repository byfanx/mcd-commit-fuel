import * as vscode from 'vscode';
import {
  McdActions,
  McdApi,
  McpClient,
  classifyTask,
  collectGitSignals,
  computeView,
  TEAM_DEFAULT_PEOPLE,
  TEAM_MAX_PEOPLE,
  TEAM_MIN_PEOPLE,
  couponOrderItem,
  defaultAssistance,
  diffClaimed,
  findStoreCoupon,
  groupCoupons,
  isClaimable,
  planTeamMeal,
  formatYuan,
  isLateNight,
  PERIOD_RULES,
  currentPeriod,
  describeMeal,
  localDate,
  menuCandidates,
  pickMeals,
  matchNutrition,
  prepareReceipt,
  readCache,
  recordSignals,
  resolveCacheDir,
  runRefresh,
  type CachedView,
  type CouponRef,
  type MyCoupons,
  type OrderItem,
  type RefreshResult,
  type Signal,
  type Store,
} from '@mcd-commit-fuel/core';
import {
  ExecutionTracker,
  claimResultDetail,
  couponEntries,
  orderConfirmDetail,
  readSettings,
  teamConfirmDetail,
  shouldRefresh,
  taskCategory,
  toPickEntries,
  type PickAction,
  type PickEntry,
  type Settings,
} from './logic.js';

const TOKEN_KEY = 'mcdFuel.mcpToken';
const LAST_CITY_KEY = 'mcdFuel.lastCity';
/** 麦当劳 MCP 开放平台，登录后在控制台申请 token */
const TOKEN_URL = 'https://open.mcd.cn/mcp';

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
}
/** 状态会随时间变化（例如构建跑满 3 分钟），定期只读缓存重新计算一次 */
const TICK_MS = 30_000;
const GIT_DEBOUNCE_MS = 2_000;

// vscode.git 扩展 API 里用到的最小子集
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { commit?: string };
    refs?: ReadonlyArray<{ type?: number }>;
    onDidChange: vscode.Event<void>;
  };
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}
const REF_TYPE_TAG = 2;

export function activate(context: vscode.ExtensionContext): void {
  const fuel = new Fuel(context);
  context.subscriptions.push(fuel);
  void fuel.start();
}

export function deactivate(): void {}

class Fuel implements vscode.Disposable {
  private readonly dir = resolveCacheDir(process.env);
  private readonly item = vscode.window.createStatusBarItem('mcdFuel.status', vscode.StatusBarAlignment.Right, 100);
  private readonly log = vscode.window.createOutputChannel('MCD Commit Fuel');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tasks = new ExecutionTracker<vscode.TaskExecution>(`vscode-${process.pid}-task`);
  private readonly shells = new ExecutionTracker<vscode.TerminalShellExecution>(`vscode-${process.pid}-sh`);
  private readonly repoKeys = new Map<string, string>();
  private settings: Settings = readSettings((key) => vscode.workspace.getConfiguration('mcdFuel').get(key));
  private git: GitApi | undefined;
  private hasToken = false;
  private view: CachedView | undefined;
  private refreshing: Promise<RefreshResult | undefined> | undefined;
  private lastAttemptAt: number | undefined;
  private gitTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item.name = 'MCD Commit Fuel';
    this.item.text = '🍟';
    this.item.command = 'mcdFuel.showDetails';
    this.item.tooltip = 'MCD Commit Fuel';
    this.item.show();
  }

  async start(): Promise<void> {
    this.registerCommands();
    this.hasToken = Boolean(await this.context.secrets.get(TOKEN_KEY));
    await this.render();
    this.watchEvents();
    await this.watchGit();
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    void this.refresh(false);
  }

  dispose(): void {
    clearInterval(this.tickTimer);
    clearTimeout(this.gitTimer);
    for (const d of this.disposables) d.dispose();
    this.item.dispose();
    this.log.dispose();
  }

  // ---- 展示 ----

  /** 只读缓存，按当前时间重新计算展示结果，不发网络请求。 */
  private async render(): Promise<{ stateChanged: boolean; lastRefreshAt?: number | undefined }> {
    const cache = await readCache(this.dir);
    const { view } = computeView(cache, Date.now(), {
      hasToken: this.hasToken,
      config: this.settings.state,
      dailyNudgeLimit: this.settings.dailyNudgeLimit,
    });
    this.view = view;
    this.item.text = view.text;
    this.item.tooltip = `${view.text}\n\n点击查看详情`;
    return { stateChanged: cache.view?.state !== view.state, lastRefreshAt: cache.lastRefreshAt };
  }

  private async tick(): Promise<void> {
    try {
      const { stateChanged, lastRefreshAt } = await this.render();
      if (
        shouldRefresh({
          focused: vscode.window.state.focused,
          now: Date.now(),
          pollMs: this.settings.pollMs,
          stateChanged,
          lastRefreshAt,
          lastAttemptAt: this.lastAttemptAt,
        })
      ) {
        void this.refresh(false);
      }
    } catch (err) {
      this.error('更新状态栏失败', err);
    }
  }

  // ---- 刷新 ----

  /** 采集 git 信号并调用刷新器。同一时间只跑一个，重复调用复用同一个 Promise。 */
  private refresh(force: boolean): Promise<RefreshResult | undefined> {
    if (this.refreshing) return this.refreshing;
    this.lastAttemptAt = Date.now();
    this.refreshing = (async () => {
      try {
        const token = await this.context.secrets.get(TOKEN_KEY);
        this.hasToken = Boolean(token);
        await this.collectGit();
        const result = await runRefresh({
          dir: this.dir,
          api: token ? new McdApi(new McpClient({ token })) : undefined,
          force,
          config: this.settings.state,
          dailyNudgeLimit: this.settings.dailyNudgeLimit,
        });
        for (const key of result.failed) {
          const entry = result.cache?.data[key];
          this.log.appendLine(`[${new Date().toISOString()}] 更新失败 ${key}：${entry?.errorKind ?? ''} ${entry?.error ?? ''}`);
        }
        return result;
      } catch (err) {
        this.error('刷新失败', err);
        return undefined;
      } finally {
        this.refreshing = undefined;
        await this.render().catch((err) => this.error('更新状态栏失败', err));
      }
    })();
    return this.refreshing;
  }

  // ---- 信号 ----

  private async record(signal: Signal): Promise<void> {
    try {
      await recordSignals(this.dir, [signal], signal.ts);
    } catch (err) {
      this.error('记录信号失败', err);
    }
    void this.tick();
  }

  private gitRoots(): string[] {
    const roots = this.git?.repositories.map((r) => r.rootUri.fsPath) ?? [];
    if (roots.length === 0) {
      for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') roots.push(f.uri.fsPath);
    }
    return [...new Set(roots)];
  }

  private async collectGit(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    const now = Date.now();
    const lists = await Promise.all(
      this.gitRoots().map((root) => collectGitSignals(root, now, { releaseTagPattern: this.settings.releaseTagPattern })),
    );
    const signals = lists.flat();
    if (signals.length) await recordSignals(this.dir, signals, now);
  }

  private scheduleGit(): void {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => {
      void this.collectGit()
        .then(() => this.tick())
        .catch((err) => this.error('读取 git 记录失败', err));
    }, GIT_DEBOUNCE_MS);
  }

  /** 只在 HEAD 或 tag 数量变化时重新读取 git 记录；普通的文件改动不触发。 */
  private watchRepo(repo: GitRepository): void {
    const key = () => {
      const tags = (repo.state.refs ?? []).filter((r) => r.type === REF_TYPE_TAG).length;
      return `${repo.state.HEAD?.commit ?? ''}|${tags}`;
    };
    const root = repo.rootUri.fsPath;
    this.repoKeys.set(root, key());
    this.disposables.push(
      repo.state.onDidChange(() => {
        const k = key();
        if (this.repoKeys.get(root) === k) return;
        this.repoKeys.set(root, k);
        this.scheduleGit();
      }),
    );
  }

  private async watchGit(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!ext) return;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      this.git = exports.getAPI(1);
      for (const repo of this.git.repositories) this.watchRepo(repo);
      this.disposables.push(
        this.git.onDidOpenRepository((repo) => {
          this.watchRepo(repo);
          this.scheduleGit();
        }),
      );
    } catch (err) {
      // 没有内置 git 扩展时退回到工作区目录 + 定时刷新
      this.error('无法连接 vscode.git，改为只在刷新时读取 git 记录', err);
    }
  }

  private watchEvents(): void {
    const d = this.disposables;
    d.push(
      vscode.tasks.onDidStartTaskProcess((e) => {
        const task = e.execution.task;
        const signal = this.tasks.start(
          e.execution,
          taskCategory({ name: task.name, groupId: task.group?.id, commandLine: commandLineOf(task) }),
          Date.now(),
        );
        if (signal) void this.record(signal);
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        const signal = this.tasks.end(e.execution, e.exitCode, Date.now());
        if (signal) void this.record(signal);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.tick();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('mcdFuel')) return;
        this.settings = readSettings((key) => vscode.workspace.getConfiguration('mcdFuel').get(key));
        void this.tick();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleGit()),
      this.context.secrets.onDidChange((e) => {
        if (e.key === TOKEN_KEY) void this.refresh(false);
      }),
    );

    // 终端 shell integration 事件（VS Code 1.93+）
    if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
      d.push(
        vscode.window.onDidStartTerminalShellExecution((e) => {
          if (!this.settings.trackTerminal) return;
          const signal = this.shells.start(e.execution, classifyTask(e.execution.commandLine.value), Date.now());
          if (signal) void this.record(signal);
        }),
        vscode.window.onDidEndTerminalShellExecution((e) => {
          const signal = this.shells.end(e.execution, e.exitCode, Date.now());
          if (signal) void this.record(signal);
        }),
      );
    }
  }

  // ---- 命令 ----

  private registerCommands(): void {
    const reg = (id: string, fn: () => Promise<unknown>) =>
      this.disposables.push(
        vscode.commands.registerCommand(id, () => fn().catch((err) => this.error(`执行 ${id} 失败`, err, true))),
      );
    reg('mcdFuel.showDetails', () => this.showDetails());
    reg('mcdFuel.refresh', () => this.manualRefresh());
    reg('mcdFuel.showReceipt', () => this.showReceipt());
    reg('mcdFuel.setToken', () => this.setToken());
    reg('mcdFuel.clearToken', () => this.clearToken());
    reg('mcdFuel.order', () => this.order());
    reg('mcdFuel.claimCoupons', () => this.claimCoupons());
    reg('mcdFuel.teamMeal', () => this.teamMeal());
    reg('mcdFuel.showCoupons', () => this.showAllCoupons());
  }

  private async showDetails(): Promise<void> {
    await this.render();
    type Item = vscode.QuickPickItem & { entry?: PickEntry };
    const items: Item[] = toPickEntries(this.view, this.hasToken).map((entry) =>
      entry.separator
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: entry.label,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.detail ? { detail: entry.detail } : {}),
            entry,
          },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: 'MCD Commit Fuel',
      placeHolder: this.view?.text ?? '',
      matchOnDescription: true,
    });
    if (picked?.entry?.action) await this.runAction(picked.entry.action, picked.entry.coupon);
  }

  private runAction(action: PickAction, coupon?: CouponRef): Promise<unknown> {
    switch (action) {
      case 'useCoupon':
        return coupon ? this.useCoupon(coupon) : Promise.resolve();
      case 'refresh':
        return this.manualRefresh();
      case 'receipt':
        return this.showReceipt();
      case 'setToken':
        return this.setToken();
      case 'clearToken':
        return this.clearToken();
      case 'order':
        return this.order();
      case 'claimCoupons':
        return this.claimCoupons();
      case 'teamMeal':
        return this.teamMeal();
      case 'allCoupons':
        return this.showAllCoupons();
    }
  }

  /** 团餐：人数 → 配送地址 → 门店 → 自动搭配 → 算价 → 模态确认 → create-order（外送）。 */
  private async teamMeal(): Promise<void> {
    const token = await this.requireToken();
    if (!token) return;
    const client = new McpClient({ token });
    const api = new McdApi(client);
    const actions = new McdActions(client);

    const people = await this.pickPeople();
    if (!people) return;

    const addresses = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在读取配送地址…' },
      () => actions.getAddresses(),
    );
    if (addresses.length === 0) {
      void vscode.window.showInformationMessage('还没有配送地址。请先在麦当劳 App 中添加地址，再回来点团餐。');
      return;
    }
    const address =
      addresses.length === 1
        ? addresses[0]
        : (
            await vscode.window.showQuickPick(
              addresses.map((a) => ({ label: a.label, address: a })),
              { title: '请团队吃一顿 · 选择配送地址' },
            )
          )?.address;
    if (!address) return;

    const stores = (
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在查询可配送团餐的门店…' },
        () => actions.getGroupStores(address.addressId),
      )
    ).filter((s) => s.open);
    if (stores.length === 0) {
      void vscode.window.showInformationMessage('这个地址附近暂时没有可配送团餐的门店。');
      return;
    }
    const store = (
      await vscode.window.showQuickPick(
        stores.map((s) => ({ label: s.storeName, ...(s.hours ? { description: `营业 ${s.hours}` } : {}), store: s })),
        { title: `请团队吃一顿 · ${people} 人 · 选择门店` },
      )
    )?.store;
    if (!store) return;

    const cache = await readCache(this.dir);
    const [menu, assistance, nutrition] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在为 ${people} 人搭配…` },
      () =>
        Promise.all([
          actions.getGroupMenu(store),
          actions.getMealAssistance(store),
          cache.data.nutrition?.value ?? api.getNutrition(),
        ]),
    );
    // 只用能对上营养数据的餐品，保证每一项都附热量
    const candidates = menu.flatMap((m) => {
      const n = matchNutrition(m, nutrition);
      return n ? [{ code: m.code, name: m.name, ...(m.price !== undefined ? { price: m.price } : {}), kcal: n.energyKcal }] : [];
    });
    const plan = planTeamMeal(candidates, people);
    if (!plan) {
      void vscode.window.showInformationMessage(`${store.storeName} 暂时凑不出合适的团餐搭配，可以换一家门店。`);
      return;
    }
    const service = defaultAssistance(assistance);
    if (!service) {
      void vscode.window.showWarningMessage('该门店当前没有可用的团餐配送服务，暂时无法下单。');
      return;
    }

    const items = plan.lines.map((l) => ({ productCode: l.code, quantity: l.quantity }));
    const quote = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在计算价格…' },
      () => actions.quoteGroup(store, service.code, items),
    );

    const ok = await vscode.window.showWarningMessage(
      `确认为 ${plan.people} 人下单团餐，应付 ${formatYuan(quote.price)}？`,
      {
        modal: true,
        detail: teamConfirmDetail({
          storeName: store.storeName,
          addressLabel: address.label,
          serviceName: service.name,
          plan,
          quote,
        }),
      },
      '确认下单',
    );
    if (ok !== '确认下单') return;

    this.log.appendLine(
      `[${new Date().toISOString()}] 用户确认团餐：${store.storeName} / ${plan.people} 人 / ${plan.lines
        .map((l) => `${l.name}×${l.quantity}`)
        .join('、')} / ${service.name}`,
    );
    const result = await actions.createGroupOrder(store, address.addressId, service.code, items);
    this.log.appendLine(`[${new Date().toISOString()}] 团餐下单结果：${result.summary}`);
    void vscode.window.showInformationMessage(`MCD Fuel：${result.summary}。请在麦当劳 App 中完成支付。`);
  }

  /** 卡包里的全部券：临期 / 到店可用 / 仅外送分组，点击到店可用的券直接下单。 */
  private async showAllCoupons(): Promise<void> {
    const token = await this.requireToken();
    if (!token) return;
    // 优先拉最新的卡包（只读），失败时用缓存
    let mine: MyCoupons | undefined;
    try {
      mine = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在读取卡包…' },
        () => new McdApi(new McpClient({ token })).getMyCoupons(),
      );
    } catch (err) {
      this.error('读取卡包失败，显示缓存的数据', err);
    }
    mine ??= (await readCache(this.dir)).data.myCoupons?.value;
    if (!mine || mine.coupons.length === 0) {
      void vscode.window.showInformationMessage('MCD Fuel：卡包里没有可用的券。');
      return;
    }

    type Item = vscode.QuickPickItem & { entry?: PickEntry };
    const items: Item[] = couponEntries(groupCoupons(mine.coupons, Date.now())).map((entry) =>
      entry.separator
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: entry.label,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.detail ? { detail: entry.detail } : {}),
            entry,
          },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: `全部可用的券（${mine.total} 张）`,
      placeHolder: '按到期日排序，点击即可用这张券下单',
      matchOnDescription: true,
    });
    if (picked?.entry?.action === 'useCoupon' && picked.entry.coupon) await this.useCoupon(picked.entry.coupon);
  }

  /** 默认 2~4 人，也可以自定义。 */
  private async pickPeople(): Promise<number | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        ...TEAM_DEFAULT_PEOPLE.map((n) => ({ label: `${n} 人`, people: n as number })),
        { label: '自定义人数…', people: 0 },
      ],
      { title: '请团队吃一顿 · 几个人？' },
    );
    if (!picked) return undefined;
    if (picked.people) return picked.people;
    const value = await vscode.window.showInputBox({
      title: '请团队吃一顿 · 自定义人数',
      prompt: `${TEAM_MIN_PEOPLE} 到 ${TEAM_MAX_PEOPLE} 人`,
      validateInput: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= TEAM_MIN_PEOPLE && n <= TEAM_MAX_PEOPLE
          ? undefined
          : `请输入 ${TEAM_MIN_PEOPLE} 到 ${TEAM_MAX_PEOPLE} 之间的整数`;
      },
    });
    return value ? Number(value) : undefined;
  }

  // ---- 写操作：都必须经过模态确认 ----

  private async requireToken(): Promise<string | undefined> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) {
      const pick = await vscode.window.showInformationMessage(
        `需要先设置麦当劳 MCP token。还没有的话，可以在 ${TOKEN_URL} 登录后到控制台申请。`,
        '设置 token',
        '去申请',
      );
      if (pick === '去申请') void vscode.env.openExternal(vscode.Uri.parse(TOKEN_URL));
      if (pick === '设置 token') await this.setToken();
      return undefined;
    }
    return token;
  }

  /** 选门店（收藏或搜索）→ 轻食 → 算价 → 取餐方式 → 模态确认 → create-order。只支持到店自取。 */
  private async order(): Promise<void> {
    const token = await this.requireToken();
    if (!token) return;
    const client = new McpClient({ token });
    const api = new McdApi(client);
    const actions = new McdActions(client);
    const cache = await readCache(this.dir);

    const favorites = cache.data.stores?.value ?? (await api.getFavoriteStores());
    const store = await this.pickStore(api, favorites, '点一份轻食 · 选择门店（到店自取）');
    if (!store) return;

    const now = Date.now();
    const period = currentPeriod(now, isLateNight(now, this.settings.state));
    const rule = PERIOD_RULES[period];
    const [menu, nutrition] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在读取 ${store.storeName} 的菜单…` },
      () => Promise.all([actions.getMenu(store.storeCode), cache.data.nutrition?.value ?? api.getNutrition()]),
    );
    // 只用这家店当前在卖、能对上营养数据的餐品；餐品类别优先，热量其次
    const picks = pickMeals(menuCandidates(menu, nutrition), {
      period,
      seed: `${localDate(now)}:${period}:order`,
      count: 12,
    }).filter((p) => p.parts.every((part) => part.code));
    if (picks.length === 0) {
      void vscode.window.showInformationMessage(`${store.storeName} 当前没有适合${rule.label}的推荐。`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      picks.map((pick) => ({
        label: `${pick.frequent ? '$(star-full) ' : ''}${pick.name}`,
        description: `${pick.kcal} kcal${pick.price !== undefined ? ` · ${formatYuan(pick.price)}` : ''}`,
        detail: describeMeal(pick),
        pick,
      })),
      {
        title: `${rule.emoji} 点一份${rule.label} · ${store.storeName} · 到店自取`,
        placeHolder:
          period === 'lateNight'
            ? '夜深了，只列出轻食和不含咖啡因的饮品'
            : `按${rule.label}推荐，每份不超过 ${rule.maxKcal}kcal；★ 为你的常点`,
      },
    );
    if (!picked) return;

    await this.confirmAndOrder(
      actions,
      store,
      picked.pick.parts.map((part) => ({ productCode: part.code!, quantity: 1 })),
      { itemName: picked.pick.name, kcal: picked.pick.kcal },
    );
  }

  /** 从详情列表点击一张券：选门店 → 确认该门店能用这张券 → 选餐品 → 确认下单。 */
  private async useCoupon(coupon: CouponRef): Promise<void> {
    const token = await this.requireToken();
    if (!token) return;
    const client = new McpClient({ token });
    const api = new McdApi(client);
    const actions = new McdActions(client);
    const cache = await readCache(this.dir);

    const favorites = cache.data.stores?.value ?? (await api.getFavoriteStores());
    const known = coupon.storeCode ? favorites.find((s) => s.storeCode === coupon.storeCode) : undefined;
    const store = known ?? (await this.pickStore(api, favorites, `使用「${coupon.title}」· 选择门店（到店自取）`));
    if (!store) return;

    const storeCoupons = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在查询 ${store.storeName} 可用的券…` },
      () => api.getStoreCoupons(store.storeCode),
    );
    const usable = findStoreCoupon(storeCoupons, coupon);
    if (!usable) {
      void vscode.window.showWarningMessage(`「${coupon.title}」在 ${store.storeName} 不可用，可以换一家门店试试。`);
      return;
    }

    const product =
      usable.products.length > 1
        ? (
            await vscode.window.showQuickPick(
              usable.products.map((p) => ({ label: p.name, product: p })),
              { title: `「${usable.title}」可用于` },
            )
          )?.product
        : usable.products[0];
    if (!product) {
      if (usable.products.length === 0) {
        void vscode.window.showWarningMessage('这张券没有返回适用的餐品，暂时无法在这里下单，请在麦当劳 App 中使用。');
      }
      return;
    }

    const nutrition = cache.data.nutrition?.value;
    await this.confirmAndOrder(actions, store, [couponOrderItem(usable, product.code)], {
      itemName: product.name,
      kcal: nutrition ? matchNutrition(product, nutrition)?.energyKcal : undefined,
      couponTitle: usable.title,
    });
  }

  /** 算价 → 选取餐方式 → 模态确认 → create-order。所有下单入口都走这里。 */
  private async confirmAndOrder(
    actions: McdActions,
    store: Store,
    items: OrderItem[],
    info: { itemName: string; kcal?: number | undefined; couponTitle?: string | undefined },
  ): Promise<void> {
    const quote = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在计算价格…' },
      () => actions.quote(store.storeCode, items),
    );
    const takeWay =
      quote.takeWays.length > 1
        ? (
            await vscode.window.showQuickPick(
              quote.takeWays.map((t) => ({ label: t.title, takeWay: t })),
              { title: '取餐方式' },
            )
          )?.takeWay
        : quote.takeWays[0];
    if (!takeWay) {
      if (quote.takeWays.length === 0) void vscode.window.showWarningMessage('该门店没有返回可选的取餐方式，暂时无法下单。');
      return;
    }

    const ok = await vscode.window.showWarningMessage(
      `确认下单 ${info.itemName}，应付 ${formatYuan(quote.price)}？`,
      {
        modal: true,
        detail: orderConfirmDetail({
          storeName: store.storeName,
          itemName: info.itemName,
          kcal: info.kcal,
          couponTitle: info.couponTitle,
          takeWay: takeWay.title,
          price: quote.price,
          discount: quote.discount,
        }),
      },
      '确认下单',
    );
    if (ok !== '确认下单') return;

    const what = `${store.storeName} / ${info.itemName}${info.couponTitle ? ` / 券：${info.couponTitle}` : ''} / ${takeWay.title}`;
    this.log.appendLine(`[${new Date().toISOString()}] 用户确认下单：${what}`);
    const result = await actions.createPickupOrder(store.storeCode, items, takeWay.code);
    this.log.appendLine(`[${new Date().toISOString()}] 下单结果：${result.summary}`);
    void vscode.window.showInformationMessage(`MCD Fuel：${result.summary}。请在麦当劳 App 中完成支付和取餐。`);
    if (info.couponTitle) void this.refresh(true);
  }

  /** 收藏门店在前，最后一项是"搜索门店"。 */
  private async pickStore(api: McdApi, favorites: Store[], title: string): Promise<Store | undefined> {
    type Item = vscode.QuickPickItem & { store?: Store; search?: true };
    const items: Item[] = [
      ...(favorites.length ? [{ label: '收藏门店', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...favorites.map((s) => ({ label: s.storeName, ...(s.address ? { description: s.address } : {}), store: s })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(search) 搜索门店…', description: '按城市和门店名或地址搜索', search: true },
    ];
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    if (!picked) return undefined;
    return picked.store ?? this.searchStore(api);
  }

  private async searchStore(api: McdApi): Promise<Store | undefined> {
    const city = (
      await vscode.window.showInputBox({
        title: '搜索门店（1/2）：城市',
        prompt: '例如：上海',
        value: this.context.globalState.get<string>(LAST_CITY_KEY) ?? '',
        validateInput: (v) => (v.trim() ? undefined : '城市不能为空'),
      })
    )?.trim();
    if (!city) return undefined;
    const keyword = await vscode.window.showInputBox({
      title: '搜索门店（2/2）：关键词',
      prompt: '门店名或地址，留空则列出该城市的门店',
    });
    if (keyword === undefined) return undefined;
    await this.context.globalState.update(LAST_CITY_KEY, city);

    const stores = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在搜索 ${city} 的门店…` },
      () => api.searchStores(city, keyword),
    );
    if (stores.length === 0) {
      void vscode.window.showInformationMessage(`在 ${city} 没有找到${keyword.trim() ? `与「${keyword.trim()}」相关的` : ''}门店。`);
      return undefined;
    }
    return (
      await vscode.window.showQuickPick(
        stores.map((s) => ({
          label: s.storeName,
          ...(s.distance !== undefined ? { description: formatDistance(s.distance) } : {}),
          ...(s.address ? { detail: s.address } : {}),
          store: s,
        })),
        { title: `${city}${keyword.trim() ? ` · ${keyword.trim()}` : ''}`, matchOnDetail: true },
      )
    )?.store;
  }

  /** 模态确认后调用 auto-bind-coupons 领取全部可领的券。 */
  private async claimCoupons(): Promise<void> {
    const token = await this.requireToken();
    if (!token) return;
    const client = new McpClient({ token });
    // 先用只读接口确认还有没有可领的券，没有就不调用写接口
    const api = new McdApi(client);
    const before = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在查询可领的券…' },
      () => api.getClaimableCoupons(),
    );
    const claimable = before.filter(isClaimable);
    if (claimable.length === 0) {
      void vscode.window.showInformationMessage('MCD Fuel：当前没有可领的券，已领取的券都在卡包里。');
      return;
    }

    const names = claimable.slice(0, 5).map((c) => `· ${c.name}`);
    if (claimable.length > 5) names.push(`· 等共 ${claimable.length} 张`);
    const ok = await vscode.window.showWarningMessage(
      `领取 ${claimable.length} 张可领的优惠券？`,
      {
        modal: true,
        detail: `${names.join('\n')}\n\n确认后会调用麦当劳 MCP 的 auto-bind-coupons，把当前可领的券全部领到你的卡包。`,
      },
      '确认领取',
    );
    if (ok !== '确认领取') return;

    this.log.appendLine(`[${new Date().toISOString()}] 用户确认领券（${claimable.length} 张）`);
    try {
      const summary = await new McdActions(client).claimAllCoupons();
      this.log.appendLine(`[${new Date().toISOString()}] 领券结果：${summary}`);
      // 领取后再查一次可领列表，对比出这次领到了哪些券；查询失败不影响领取结果
      const after = await api.getClaimableCoupons().catch(() => undefined);
      const diff = after ? diffClaimed(before, after) : undefined;
      if (diff) {
        const names = diff.claimed.map((c) => `${c.name}×${c.count}`).join('、') || '无';
        this.log.appendLine(`[${new Date().toISOString()}] 本次领到：${names}`);
      }
      const result = claimResultDetail(diff, summary);
      void vscode.window.showInformationMessage(`MCD Fuel：${result.title}`, { modal: true, detail: result.detail });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[${new Date().toISOString()}] 领券失败：${reason}`);
      void vscode.window.showWarningMessage(`MCD Fuel：领券失败（${reason.slice(0, 120)}）`);
    }
    await this.refresh(true);
  }

  private async manualRefresh(): Promise<void> {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'MCD Fuel 刷新中' },
      () => this.refresh(true),
    );
    if (!result) {
      void vscode.window.showWarningMessage('MCD Fuel：刷新失败，详情见输出面板 “MCD Commit Fuel”。');
    } else if (result.skipped) {
      void vscode.window.showInformationMessage('MCD Fuel：另一个窗口或终端正在刷新，稍后会自动更新。');
    } else if (result.failed.length) {
      void vscode.window.showWarningMessage(`MCD Fuel：${result.failed.length} 项数据更新失败，已显示上次的数据。`);
    }
  }

  private async showReceipt(): Promise<void> {
    await this.collectGit();
    const token = await this.context.secrets.get(TOKEN_KEY);
    const content = await prepareReceipt({
      dir: this.dir,
      api: token ? new McdApi(new McpClient({ token })) : undefined,
      config: this.settings.state,
    });
    const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async setToken(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: '设置麦当劳 MCP token',
      prompt: `在 ${TOKEN_URL} 登录后，到“控制台”点击“激活”申请并复制 token。token 只保存在本机的 VS Code SecretStorage 中`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'token 不能为空'),
    });
    if (!value?.trim()) return;
    await this.context.secrets.store(TOKEN_KEY, value.trim());
    this.hasToken = true;
    await this.manualRefresh();
  }

  private async clearToken(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      '清除已保存的 MCP token？清除后状态栏只显示本地状态，需要重新设置才能获取积分和券。',
      { modal: true },
      '清除',
    );
    if (ok !== '清除') return;
    await this.context.secrets.delete(TOKEN_KEY);
    this.hasToken = false;
    await this.render();
  }

  private error(message: string, err: unknown, notify = false): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.log.appendLine(`[${new Date().toISOString()}] ${message}：${detail}`);
    // 提示里带上原因，方便排查；McpError 的信息里不会包含 token
    if (notify) void vscode.window.showErrorMessage(`MCD Fuel：${message}（${detail.slice(0, 120)}）`);
  }
}

/** 取任务的命令行，只用于判断构建/测试类别。 */
function commandLineOf(task: vscode.Task): string {
  const text = (v: string | vscode.ShellQuotedString) => (typeof v === 'string' ? v : v.value);
  const exec = task.execution;
  const parts: string[] = [];
  if (exec instanceof vscode.ShellExecution) {
    if (exec.commandLine) parts.push(exec.commandLine);
    if (exec.command) parts.push(text(exec.command), ...(exec.args ?? []).map(text));
  } else if (exec instanceof vscode.ProcessExecution) {
    parts.push(exec.process, ...exec.args);
  }
  const script = (task.definition as { script?: unknown }).script;
  if (typeof script === 'string') parts.push(script);
  return parts.join(' ');
}
