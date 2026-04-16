(function () {
  var basePath = '/ecauth';

  var pageMeta = {
    dashboard: { title: '总览' },
    users: { title: '用户管理' },
    projects: { title: '项目注册' },
    organization: { title: '组织管理' },
  };

  var state = {
    activePage: 'dashboard',
    session: null,
    users: [],
    projects: [],
    orgUnits: [],
    orgMembers: [],
    selectedOrgUserIds: new Set(),
    expandedDepts: new Set(),
    grantModalUserId: null,
    grantModalEcUserIds: null,
  };

  var noticeBox = document.getElementById('notice-box');
  var pageTitle = document.getElementById('page-title');
  var sessionPill = document.getElementById('session-pill');
  var sidebarSummary = document.getElementById('sidebar-summary');

  var userCountPill = document.getElementById('user-count-pill');
  var projectCountPill = document.getElementById('project-count-pill');
  var orgSelectionPill = document.getElementById('org-selection-pill');
  var orgCountPill = document.getElementById('org-count-pill');
  var orgLastSyncPill = document.getElementById('org-last-sync-pill');

  var userKeywordInput = document.getElementById('user-keyword-input');
  var userStatusFilter = document.getElementById('user-status-filter');
  var userAdminFilter = document.getElementById('user-admin-filter');
  var usersTableBody = document.getElementById('users-table-body');

  var manifestForm = document.getElementById('manifest-form');
  var manifestInput = document.getElementById('manifest-input');
  var catalogList = document.getElementById('catalog-list');

  var orgKeywordInput = document.getElementById('org-keyword-input');
  var orgDeptFilter = document.getElementById('org-dept-filter');
  var orgStatusFilter = document.getElementById('org-status-filter');
  var orgUnitList = document.getElementById('org-unit-list');
  var orgMembersTableBody = document.getElementById('org-members-table-body');

  var grantModal = document.getElementById('grant-modal');
  var grantModalTitle = document.getElementById('grant-modal-title');
  var grantModalBody = document.getElementById('grant-modal-body');

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showNotice(msg, isError) {
    if (!msg) { noticeBox.style.display = 'none'; noticeBox.classList.remove('error'); return; }
    noticeBox.style.display = 'block';
    noticeBox.classList.toggle('error', !!isError);
    noticeBox.textContent = msg;
  }

  function api(path, opts) {
    return fetch(basePath + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts))
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, text: t }; }); })
      .then(function (r) {
        var data = r.text ? JSON.parse(r.text) : {};
        if (!r.ok) throw new Error(data.error || data.msg || '请求失败');
        return data;
      });
  }

  function fmtTime(v) { return v ? new Date(v).toLocaleString('zh-CN') : '未记录'; }
  function fmtStatus(s) { return { pending_review: '待审核', active: '已通过', rejected: '已拒绝', disabled: '已停用' }[s] || s; }

  function statusPill(s) {
    if (s === 'active')         return '<span class="pill pill-active">已通过</span>';
    if (s === 'pending_review') return '<span class="pill pill-pending">待审核</span>';
    if (s === 'disabled')       return '<span class="pill pill-disabled">已停用</span>';
    return '<span class="pill pill-unknown">' + esc(fmtStatus(s)) + '</span>';
  }

  function setActivePage(page) {
    state.activePage = page;
    document.querySelectorAll('.page').forEach(function (n) { n.classList.toggle('active', n.id === 'page-' + page); });
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-page') === page); });
    pageTitle.textContent = pageMeta[page].title;
  }

  function permChips(perms) {
    if (!perms || !perms.projects || !perms.projects.length) return '<span class="muted">\u2014</span>';
    return perms.projects.map(function (p) {
      return p.features.map(function (f) {
        return '<span class="perm-chip">' + esc(p.projectKey + ' / ' + f.featureKey) + '</span>';
      }).join('');
    }).join('');
  }

  /* ── Render ── */

  function renderDashboard() {
    var pending = state.users.filter(function (u) { return u.status === 'pending_review'; }).length;
    var provisioned = state.users.filter(function (u) { return u.provisionSource === 'org_sync'; }).length;
    var times = state.orgMembers.map(function (m) { return m.syncedAt; }).filter(Boolean).sort();
    var lastSync = times.length ? times[times.length - 1] : '';

    document.getElementById('dashboard-user-total').textContent = state.users.length;
    document.getElementById('dashboard-pending-total').textContent = pending;
    document.getElementById('dashboard-project-total').textContent = state.projects.length;
    document.getElementById('dashboard-org-member-total').textContent = state.orgMembers.length;
    document.getElementById('org-unit-total').textContent = state.orgUnits.length;
    document.getElementById('org-member-total').textContent = state.orgMembers.length;
    document.getElementById('org-provisioned-total').textContent = provisioned;
    orgLastSyncPill.textContent = lastSync ? '最近同步 ' + fmtTime(lastSync) : '未同步';

    var items = [
      '已同步组织成员 ' + state.orgMembers.length + ' 人，可直接授权',
      '当前待审核用户 ' + pending + ' 人',
      '项目目录 ' + state.projects.length + ' 个',
    ];
    document.getElementById('dashboard-highlight-list').innerHTML = items.map(function (t) {
      return '<div class="dash-status-item">' + esc(t) + '</div>';
    }).join('');
  }

  function renderUsers() {
    userCountPill.textContent = state.users.length + ' users';

    var chips = '';
    if (userStatusFilter.value) {
      chips += '<span class="filter-chip">状态: ' + esc(fmtStatus(userStatusFilter.value)) + '<button class="filter-chip-remove" data-chip-clear="status" type="button">×</button></span>';
    }
    if (userAdminFilter.value) {
      chips += '<span class="filter-chip">角色: ' + esc(userAdminFilter.value === 'true' ? '管理员' : '普通用户') + '<button class="filter-chip-remove" data-chip-clear="admin" type="button">×</button></span>';
    }
    if (userKeywordInput.value.trim()) {
      chips += '<span class="filter-chip">关键词: ' + esc(userKeywordInput.value.trim()) + '<button class="filter-chip-remove" data-chip-clear="keyword" type="button">×</button></span>';
    }
    document.getElementById('user-filter-chips').innerHTML = chips;

    if (!state.users.length) {
      usersTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">没有符合筛选条件的用户。</td></tr>';
      return;
    }

    usersTableBody.innerHTML = state.users.map(function (u) {
      var tooltip = '最近登录: ' + fmtTime(u.lastLoginAt);
      var subInfo = u.employeeId || u.ecUserId || u.id;
      var statusCol = statusPill(u.status);
      if (u.isAdmin) statusCol += ' <span class="pill pill-admin">管理员</span>';

      var deptCell = u.deptPath
        ? '<span class="muted">' + esc(u.deptPath) + '</span>'
        : '<span class="muted">\u2014</span>';

      var primaryAction, primaryClass, primaryLabel;
      if (u.status === 'active') {
        primaryAction = 'disable'; primaryClass = 'btn btn-xs btn-outline'; primaryLabel = '停用';
      } else {
        primaryAction = 'approve'; primaryClass = 'btn btn-xs btn-primary'; primaryLabel = '通过';
      }

      return '<tr class="user-row" data-user-id="' + esc(u.id) + '">'
        + '<td><div class="person-cell" data-tooltip="' + esc(tooltip) + '">'
        + '<div><strong>' + esc(u.displayName) + '</strong>'
        + (u.ecTitle ? '<span class="person-title">' + esc(u.ecTitle) + '</span>' : '')
        + '</div>'
        + (subInfo ? '<span class="sub">' + esc(subInfo) + '</span>' : '')
        + '</div></td>'
        + '<td>' + statusCol + '</td>'
        + '<td>' + deptCell + '</td>'
        + '<td style="position:relative">'
        + permChips(u.permissions)
        + '<div class="user-row-actions">'
        + '<button class="' + esc(primaryClass) + '" data-action="review" data-review-action="' + esc(primaryAction) + '" type="button">' + esc(primaryLabel) + '</button>'
        + '<button class="btn btn-xs btn-outline" data-action="open-grant" type="button">授权</button>'
        + '<button class="btn btn-xs btn-outline" data-action="toggle-admin" type="button">' + esc(u.isAdmin ? '取消管理员' : '设为管理员') + '</button>'
        + '<button class="btn btn-xs btn-danger-text" data-action="review" data-review-action="reject" type="button">拒绝</button>'
        + '</div></td></tr>';
    }).join('');
  }

  function renderProjects() {
    projectCountPill.textContent = state.projects.length + ' projects';

    if (!state.projects.length) {
      catalogList.innerHTML = '<div class="empty-state">项目目录为空。</div>';
      return;
    }

    catalogList.innerHTML = state.projects.map(function (p) {
      return '<div class="catalog-item"><div style="display:flex;justify-content:space-between;align-items:center;">'
        + '<div><h4>' + esc(p.projectName) + '</h4><p class="sub">' + esc(p.projectKey) + '</p></div>'
        + '<span class="badge badge-success">' + p.features.length + ' features</span></div>'
        + '<div>' + p.features.map(function (f) {
          return '<span class="perm-chip">' + esc(f.featureKey) + '</span>';
        }).join('') + '</div></div>';
    }).join('');
  }

  /* ── Org tree ── */

  function buildTree(units) {
    var map = {};
    units.forEach(function (u) { map[String(u.dept_id)] = { unit: u, children: [] }; });
    var roots = [];
    units.forEach(function (u) {
      var pid = u.parent_dept_id ? String(u.parent_dept_id) : null;
      if (pid && map[pid]) map[pid].children.push(map[String(u.dept_id)]);
      else roots.push(map[String(u.dept_id)]);
    });
    return roots;
  }

  function flattenDepts(nodes, level, result) {
    var prefix = level === 0 ? '' : '\u3000'.repeat(level - 1) + '\u2514 ';
    nodes.forEach(function (n) {
      result.push({ id: String(n.unit.dept_id), label: prefix + n.unit.dept_name });
      if (n.children.length) flattenDepts(n.children, level + 1, result);
    });
  }

  function renderTree(nodes, level, sel) {
    var html = '';
    nodes.forEach(function (n) {
      var u = n.unit, hasKids = n.children.length > 0, id = String(u.dept_id);
      var expanded = state.expandedDepts.has(id);
      var pad = 12 + level * 20;

      html += '<div class="unit-item' + (id === sel ? ' active' : '') + '" style="padding-left:' + pad + 'px">';
      if (hasKids) {
        html += '<button class="tree-toggle" type="button" data-tree-toggle="' + esc(id) + '">' + (expanded ? '&#9660;' : '&#9658;') + '</button>';
      } else {
        html += '<span class="tree-leaf"></span>';
      }
      html += '<button class="tree-dept-btn" type="button" data-org-dept="' + esc(id) + '">'
        + '<strong>' + esc(u.dept_name) + '</strong>'
        + '<span class="unit-member-count">' + esc(String(u.member_count)) + ' 人</span>'
        + '</button></div>';
      if (hasKids && expanded) html += renderTree(n.children, level + 1, sel);
    });
    return html;
  }

  function renderOrgUnits() {
    orgCountPill.textContent = state.orgUnits.length + ' units';
    var sel = orgDeptFilter.value;
    var roots = buildTree(state.orgUnits);
    var flat = [];
    flattenDepts(roots, 0, flat);

    orgDeptFilter.innerHTML = '<option value="">全部部门</option>' + flat.map(function (d) {
      return '<option value="' + esc(d.id) + '"' + (d.id === sel ? ' selected' : '') + '>' + esc(d.label) + '</option>';
    }).join('');

    if (!state.orgUnits.length) {
      orgUnitList.innerHTML = '<div class="empty-state">尚未同步部门。</div>';
      return;
    }
    orgUnitList.innerHTML = renderTree(roots, 0, sel);
  }

  function renderOrgMembers() {
    orgSelectionPill.textContent = '已选 ' + state.selectedOrgUserIds.size + ' 人';
    if (!state.orgMembers.length) {
      orgMembersTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">没有符合条件的同步成员。</td></tr>';
      return;
    }
    orgMembersTableBody.innerHTML = state.orgMembers.map(function (m) {
      var ck = state.selectedOrgUserIds.has(m.ecUserId) ? ' checked' : '';
      var ecStatusPill = String(m.status) === '1'
        ? '<span class="pill pill-unknown">EC 禁用</span>'
        : '<span class="pill pill-active">EC 正常</span>';

      var memberInfo = '<div class="person-cell">'
        + '<strong>' + esc(m.userName) + '</strong>'
        + ((m.account || m.title) ? '<span class="sub">' + esc([m.account, m.title].filter(Boolean).join(' · ')) + '</span>' : '')
        + '</div>';

      var deptCell = m.deptName
        ? '<span class="pill pill-unknown">' + esc(m.deptName) + '</span>'
        : '<span class="muted">—</span>';

      var localAccount = m.user
        ? '<div class="person-cell"><strong>' + esc(m.user.displayName) + '</strong>'
          + '<span class="sub">' + statusPill(m.user.status) + '</span></div>'
        : '<span class="muted">未关联</span>';

      return '<tr>'
        + '<td class="checkbox-cell"><input type="checkbox" data-org-select="' + esc(m.ecUserId) + '"' + ck + '></td>'
        + '<td>' + memberInfo + ' ' + ecStatusPill + '</td>'
        + '<td>' + deptCell + '</td>'
        + '<td>' + localAccount + '</td>'
        + '<td>' + permChips(m.permissions) + '</td></tr>';
    }).join('');
  }

  /* ── Grant modal ── */

  function openGrantModal(userId) {
    var user = state.users.find(function (u) { return u.id === userId; });
    if (!user) return;
    state.grantModalUserId = userId;
    grantModalTitle.textContent = '授权管理 - ' + user.displayName;

    // Build set of already granted features
    var granted = new Set();
    if (user.permissions && user.permissions.projects) {
      user.permissions.projects.forEach(function (p) {
        p.features.forEach(function (f) { granted.add(p.projectKey + '||' + f.featureKey); });
      });
    }

    if (!state.projects.length) {
      grantModalBody.innerHTML = '<div class="empty-state">暂无已注册的项目。</div>';
      grantModal.classList.add('open');
      return;
    }

    var html = state.projects.map(function (proj) {
      var allGranted = proj.features.length > 0 && proj.features.every(function (f) {
        return granted.has(proj.projectKey + '||' + f.featureKey);
      });
      var projChecked = allGranted ? ' checked' : '';
      var projId = 'gm-p-' + esc(proj.projectKey);

      var h = '<div class="grant-project-group">'
        + '<label class="grant-project-label">'
        + '<input type="checkbox" id="' + projId + '" data-gm-project="' + esc(proj.projectKey) + '"' + projChecked + '>'
        + '<span>' + esc(proj.projectName) + ' (' + esc(proj.projectKey) + ')</span>'
        + '</label>'
        + '<div class="grant-feature-list" data-gm-features="' + esc(proj.projectKey) + '">';
      proj.features.forEach(function (f) {
        var fChecked = granted.has(proj.projectKey + '||' + f.featureKey) ? ' checked' : '';
        h += '<label class="grant-feature-item">'
          + '<input type="checkbox" data-gm-feature="' + esc(proj.projectKey) + '||' + esc(f.featureKey) + '"' + fChecked + '>'
          + '<span>' + esc(f.featureKey) + '</span>'
          + '</label>';
      });
      h += '</div></div>';
      return h;
    }).join('');
    grantModalBody.innerHTML = html;
    grantModal.classList.add('open');
  }

  function closeGrantModal() {
    grantModal.classList.remove('open');
    state.grantModalUserId = null;
    state.grantModalEcUserIds = null;
  }

  function openOrgGrantModal(ecUserIds) {
    state.grantModalUserId = null;
    state.grantModalEcUserIds = ecUserIds;
    grantModalTitle.textContent = '批量授权 - 已选 ' + ecUserIds.length + ' 人';

    if (!state.projects.length) {
      grantModalBody.innerHTML = '<div class="empty-state">暂无已注册的项目。</div>';
      grantModal.classList.add('open');
      return;
    }

    var html = state.projects.map(function (proj) {
      var projId = 'gm-p-' + esc(proj.projectKey);
      var h = '<div class="grant-project-group">'
        + '<label class="grant-project-label">'
        + '<input type="checkbox" id="' + projId + '" data-gm-project="' + esc(proj.projectKey) + '">'
        + '<span>' + esc(proj.projectName) + ' (' + esc(proj.projectKey) + ')</span>'
        + '</label>'
        + '<div class="grant-feature-list" data-gm-features="' + esc(proj.projectKey) + '">';
      proj.features.forEach(function (f) {
        h += '<label class="grant-feature-item">'
          + '<input type="checkbox" data-gm-feature="' + esc(proj.projectKey) + '||' + esc(f.featureKey) + '">'
          + '<span>' + esc(f.featureKey) + '</span>'
          + '</label>';
      });
      h += '</div></div>';
      return h;
    }).join('');
    grantModalBody.innerHTML = html;
    grantModal.classList.add('open');
  }

  function saveGrants() {
    // Single user grant (from user list)
    var userId = state.grantModalUserId;
    if (userId) {
      saveSingleUserGrants(userId);
      return;
    }
    // Batch org member grant
    var ecUserIds = state.grantModalEcUserIds;
    if (ecUserIds && ecUserIds.length) {
      saveOrgBatchGrants(ecUserIds);
      return;
    }
    closeGrantModal();
  }

  function saveSingleUserGrants(userId) {
    var grants = [];
    grantModalBody.querySelectorAll('input[data-gm-feature]:checked').forEach(function (cb) {
      var key = cb.getAttribute('data-gm-feature');
      if (!key) return;
      var parts = key.split('||');
      if (parts.length === 2) grants.push({ projectKey: parts[0], featureKey: parts[1] });
    });

    var user = state.users.find(function (u) { return u.id === userId; });
    var currentGrants = [];
    if (user && user.permissions && user.permissions.projects) {
      user.permissions.projects.forEach(function (p) {
        p.features.forEach(function (f) { currentGrants.push({ projectKey: p.projectKey, featureKey: f.featureKey }); });
      });
    }

    var toRevoke = currentGrants.filter(function (cg) {
      return !grants.some(function (g) { return g.projectKey === cg.projectKey && g.featureKey === cg.featureKey; });
    });
    var toGrant = grants.filter(function (g) {
      return !currentGrants.some(function (cg) { return cg.projectKey === g.projectKey && g.featureKey === cg.featureKey; });
    });

    var promises = [];
    if (toGrant.length) promises.push(api('/api/admin/users/' + encodeURIComponent(userId) + '/grants', { method: 'POST', body: JSON.stringify({ grants: toGrant }) }));
    if (toRevoke.length) promises.push(api('/api/admin/users/' + encodeURIComponent(userId) + '/grants', { method: 'DELETE', body: JSON.stringify({ grants: toRevoke }) }));

    if (!promises.length) { closeGrantModal(); showNotice('权限未变化'); return; }

    Promise.all(promises)
      .then(function () { return Promise.all([loadUsers(), loadOrgMembers()]); })
      .then(function () { renderDashboard(); closeGrantModal(); showNotice('授权已更新'); })
      .catch(function (err) { showNotice(err.message, true); });
  }

  function saveOrgBatchGrants(ecUserIds) {
    var grants = [];
    grantModalBody.querySelectorAll('input[data-gm-feature]:checked').forEach(function (cb) {
      var key = cb.getAttribute('data-gm-feature');
      if (!key) return;
      var parts = key.split('||');
      if (parts.length === 2) grants.push({ projectKey: parts[0], featureKey: parts[1] });
    });

    if (!grants.length) { showNotice('请至少选择一个功能', true); return; }

    api('/api/admin/org/members/grants', {
      method: 'POST',
      body: JSON.stringify({ ecUserIds: ecUserIds, grants: grants }),
    }).then(function () { return Promise.all([loadUsers(), loadOrgMembers()]); })
      .then(function () { renderDashboard(); closeGrantModal(); showNotice('已为 ' + ecUserIds.length + ' 人授权'); })
      .catch(function (err) { showNotice(err.message, true); });
  }

  /* ── Loaders ── */

  function loadSession() {
    return api('/api/auth/status').then(function (payload) {
      state.session = payload;
      if (!payload.authenticated) {
        window.location.href = basePath + '/auth/login?returnTo=' + encodeURIComponent(window.location.origin + basePath + '/admin');
        return;
      }
      if (!payload.user || !payload.user.isAdmin || payload.user.status !== 'active') {
        sessionPill.textContent = '无管理权限';
        sidebarSummary.textContent = '当前账号不是已启用管理员';
        throw new Error('当前账号不是已启用管理员');
      }
      sessionPill.textContent = payload.user.displayName;
      sidebarSummary.textContent = '已启用管理员';
    });
  }

  function loadUsers() {
    var p = new URLSearchParams();
    if (userKeywordInput.value.trim()) p.set('keyword', userKeywordInput.value.trim());
    if (userStatusFilter.value) p.set('status', userStatusFilter.value);
    if (userAdminFilter.value) p.set('isAdmin', userAdminFilter.value);
    return api('/api/admin/users' + (p.toString() ? '?' + p : '')).then(function (d) {
      state.users = d.users || [];
      renderUsers();
    });
  }

  function loadProjects() {
    return api('/api/admin/projects').then(function (d) {
      state.projects = d.projects || [];
      renderProjects();
      renderUsers();
    });
  }

  function loadOrgUnits() {
    return api('/api/admin/org/units').then(function (d) {
      state.orgUnits = d.units || [];
      renderOrgUnits();
    });
  }

  function loadOrgMembers() {
    var p = new URLSearchParams();
    if (orgKeywordInput.value.trim()) p.set('keyword', orgKeywordInput.value.trim());
    if (orgDeptFilter.value) p.set('deptId', orgDeptFilter.value);
    if (orgStatusFilter.value) p.set('status', orgStatusFilter.value);
    return api('/api/admin/org/members' + (p.toString() ? '?' + p : '')).then(function (d) {
      state.orgMembers = d.members || [];
      var valid = new Set(state.orgMembers.map(function (m) { return m.ecUserId; }));
      state.selectedOrgUserIds = new Set(Array.from(state.selectedOrgUserIds).filter(function (id) { return valid.has(id); }));
      renderOrgMembers();
    });
  }

  function refreshAll() {
    return loadSession().then(function () {
      return Promise.all([loadProjects(), loadUsers(), loadOrgUnits(), loadOrgMembers()]);
    }).then(function () { renderDashboard(); });
  }

  /* ── Events ── */

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var p = btn.getAttribute('data-page');
      if (p && pageMeta[p]) setActivePage(p);
    });
  });

  document.querySelectorAll('.page-anchor').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var p = btn.getAttribute('data-jump-page');
      if (p && pageMeta[p]) setActivePage(p);
    });
  });

  /* ── User filter events (inline toolbar) ── */

  function doUserSearch() {
    loadUsers().then(function () { renderDashboard(); }).catch(function (err) { showNotice(err.message, true); });
  }

  document.getElementById('user-search-btn').addEventListener('click', doUserSearch);
  userKeywordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doUserSearch(); });
  userStatusFilter.addEventListener('change', doUserSearch);
  userAdminFilter.addEventListener('change', doUserSearch);

  document.getElementById('user-reset-filters').addEventListener('click', function () {
    userKeywordInput.value = '';
    userStatusFilter.value = '';
    userAdminFilter.value = '';
    loadUsers().then(function () { renderDashboard(); }).catch(function (err) { showNotice(err.message, true); });
  });

  // Filter chip clear
  document.getElementById('user-filter-chips').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-chip-clear]');
    if (!btn) return;
    var field = btn.getAttribute('data-chip-clear');
    if (field === 'status') userStatusFilter.value = '';
    if (field === 'admin')  userAdminFilter.value = '';
    if (field === 'keyword') userKeywordInput.value = '';
    doUserSearch();
  });

  // Close all dropdowns when clicking outside
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown.open').forEach(function (d) { d.classList.remove('open'); });
    }
  });

  usersTableBody.addEventListener('click', function (e) {
    var target = e.target;
    if (!(target instanceof HTMLButtonElement)) return;
    var row = target.closest('[data-user-id]');
    var uid = row ? row.getAttribute('data-user-id') : '';

    var action = target.getAttribute('data-action');

    if (!uid || !action) return;

    var p;
    if (action === 'review') {
      var reviewAction = target.getAttribute('data-review-action');
      p = api('/api/admin/users/' + encodeURIComponent(uid) + '/review', {
        method: 'POST',
        body: JSON.stringify({ action: reviewAction }),
      });
    } else if (action === 'toggle-admin') {
      var user = state.users.find(function (u) { return u.id === uid; });
      p = api('/api/admin/users/' + encodeURIComponent(uid) + '/admin', {
        method: 'POST',
        body: JSON.stringify({ isAdmin: !(user && user.isAdmin) }),
      });
    } else if (action === 'open-grant') {
      openGrantModal(uid);
      return;
    } else {
      return;
    }

    p.then(function () { return Promise.all([loadUsers(), loadOrgMembers()]); })
      .then(function () { renderDashboard(); showNotice('操作已完成'); })
      .catch(function (err) { showNotice(err.message, true); });
  });

  /* ── Grant modal events ── */
  document.getElementById('grant-modal-close').addEventListener('click', closeGrantModal);
  document.getElementById('grant-modal-cancel').addEventListener('click', closeGrantModal);
  grantModal.addEventListener('click', function (e) { if (e.target === grantModal) closeGrantModal(); });
  document.getElementById('grant-modal-save').addEventListener('click', saveGrants);

  // Project checkbox toggles all features
  grantModalBody.addEventListener('change', function (e) {
    var target = e.target;
    if (target.getAttribute('data-gm-project')) {
      var pk = target.getAttribute('data-gm-project');
      var list = grantModalBody.querySelector('[data-gm-features="' + pk + '"]');
      if (list) {
        list.querySelectorAll('input[data-gm-feature]').forEach(function (cb) { cb.checked = target.checked; });
      }
    }
    // When a feature changes, update project checkbox state
    if (target.getAttribute('data-gm-feature')) {
      var key = target.getAttribute('data-gm-feature');
      var parts = key.split('||');
      if (parts.length === 2) {
        var projCb = grantModalBody.querySelector('input[data-gm-project="' + parts[0] + '"]');
        var featureList = grantModalBody.querySelector('[data-gm-features="' + parts[0] + '"]');
        if (projCb && featureList) {
          var all = featureList.querySelectorAll('input[data-gm-feature]');
          var checked = featureList.querySelectorAll('input[data-gm-feature]:checked');
          projCb.checked = all.length > 0 && all.length === checked.length;
        }
      }
    }
  });

  manifestForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var manifest;
    try { manifest = JSON.parse(manifestInput.value); } catch (err) { showNotice('JSON 格式错误: ' + err.message, true); return; }
    api('/api/admin/projects/register', { method: 'POST', body: JSON.stringify(manifest) })
      .then(function () { return loadProjects(); })
      .then(function () { renderDashboard(); showNotice('项目已注册或更新'); })
      .catch(function (err) { showNotice(err.message, true); });
  });

  /* ── Org filter events (inline toolbar) ── */

  function doOrgSearch() {
    loadOrgMembers().catch(function (err) { showNotice(err.message, true); });
  }

  document.getElementById('org-search-btn').addEventListener('click', doOrgSearch);
  orgKeywordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doOrgSearch(); });
  orgDeptFilter.addEventListener('change', doOrgSearch);
  orgStatusFilter.addEventListener('change', doOrgSearch);

  document.getElementById('org-reset-filters').addEventListener('click', function () {
    orgKeywordInput.value = '';
    orgDeptFilter.value = '';
    orgStatusFilter.value = '';
    Promise.all([loadOrgMembers(), Promise.resolve(renderOrgUnits())])
      .catch(function (err) { showNotice(err.message, true); });
  });

  orgUnitList.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-tree-toggle]');
    if (toggle) {
      var id = toggle.getAttribute('data-tree-toggle');
      if (id) { state.expandedDepts.has(id) ? state.expandedDepts.delete(id) : state.expandedDepts.add(id); renderOrgUnits(); }
      return;
    }
    var btn = e.target.closest('[data-org-dept]');
    if (btn) {
      var deptId = btn.getAttribute('data-org-dept') || '';
      orgDeptFilter.value = deptId;
      // also expand this node so its children become visible
      if (deptId) { state.expandedDepts.add(deptId); }
      Promise.all([loadOrgMembers(), Promise.resolve(renderOrgUnits())])
        .catch(function (err) { showNotice(err.message, true); });
    }
  });

  orgMembersTableBody.addEventListener('change', function (e) {
    if (!(e.target instanceof HTMLInputElement) || !e.target.hasAttribute('data-org-select')) return;
    var id = e.target.getAttribute('data-org-select');
    if (!id) return;
    e.target.checked ? state.selectedOrgUserIds.add(id) : state.selectedOrgUserIds.delete(id);
    orgSelectionPill.textContent = '已选 ' + state.selectedOrgUserIds.size + ' 人';
  });

  document.getElementById('org-batch-grant-btn').addEventListener('click', function () {
    var ids = Array.from(state.selectedOrgUserIds);
    if (!ids.length) { showNotice('请先选择至少一个组织成员', true); return; }
    openOrgGrantModal(ids);
  });

  document.getElementById('org-sync-button').addEventListener('click', function () {
    api('/api/admin/org/sync', { method: 'POST' })
      .then(function (payload) {
        return Promise.all([loadUsers(), loadOrgUnits(), loadOrgMembers()]).then(function () { return payload; });
      })
      .then(function (payload) { renderDashboard(); showNotice('同步完成：部门 ' + payload.summary.unitCount + ' 个，成员 ' + payload.summary.memberCount + ' 人'); })
      .catch(function (err) { showNotice(err.message, true); });
  });

  document.getElementById('refresh-button').addEventListener('click', function () {
    refreshAll().then(function () { showNotice('数据已刷新'); }).catch(function (err) { showNotice(err.message, true); });
  });

  document.getElementById('go-home-button').addEventListener('click', function () { window.location.href = basePath + '/'; });
  document.getElementById('logout-button').addEventListener('click', function () {
    fetch(basePath + '/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () { window.location.href = basePath + '/'; });
  });

  refreshAll().catch(function (err) { showNotice(err.message || '初始化失败', true); });
})();
