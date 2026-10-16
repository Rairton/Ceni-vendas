import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

(() => {
  'use strict';

  const firebaseConfig = {
    apiKey: 'AIzaSyB8bllF_Dtv8m5KQWE1UB0CUpMrBm6tgpw',
    authDomain: 'ceni-sistema-91fc0.firebaseapp.com',
    projectId: 'ceni-sistema-91fc0',
    storageBucket: 'ceni-sistema-91fc0.firebasestorage.app',
    messagingSenderId: '37904088103',
    appId: '1:37904088103:web:71850292e75661cda7e202'
  };
  const STAFF_NAMES = ['Caixa 1', 'Caixa 2', 'Caixa 3'];
  const COLLECTIONS = ['produtos', 'servicos', 'promocoes'];
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const state = { produtos: [], servicos: [], promocoes: [] };
  let db;
  let cart = [];
  let activeCategory = 'Tudo';
  const initializedCollections = new Set();
  let cloudReady = false;
  let isSubmitting = false;

  const currency = value => Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
  const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const escapeHtml = value => String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const itemName = item => item.name || item.nome || 'Item sem nome';
  const itemPrice = item => {
    const salePrice = Number(item.salePrice);
    if (Number.isFinite(salePrice)) return Math.max(0, roundMoney(salePrice));
    const cost = Number(item.cost) || 0;
    const margin = Number(item.margin) || 0;
    return Math.max(0, roundMoney(cost * (1 + margin / 100)));
  };
  const itemCategory = item => item.tag || item.category || item.sector || 'Outros';
  const itemCategories = item => [...new Set([item.tag, item.category, item.sector].filter(Boolean))];

  function notify(message, isError = false) {
    const region = $('#toastRegion');
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function setConnection(status, message) {
    $('#connectionStatus').textContent = message;
    $('#connectionDot').classList.toggle('live', status === 'live');
    $('#connectionDot').classList.toggle('error', status === 'error');
  }

  function reportError(error) {
    console.error('Erro no PDV da equipe.', error);
    const message = error && error.code === 'permission-denied'
      ? 'Acesso negado pelo Firestore. Peça ao responsável para conferir as regras de acesso.'
      : error && error.message
        ? error.message
        : 'Não foi possível concluir a operação. Tente novamente.';
    notify(message, true);
  }

  function renderAttendants() {
    const select = $('#attendantSelect');
    const selected = select.value;
    select.innerHTML = `<option value="">Selecione seu nome</option>${STAFF_NAMES
      .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    if (STAFF_NAMES.includes(selected)) select.value = selected;
  }

  function getPromotion(productId) {
    return state.promocoes.find(promo => promo.productId === productId && promo.active === true);
  }

  function promotionUnitDiscount(promo, price) {
    if (!promo) return 0;
    const value = Number(promo.value) || 0;
    const type = String(promo.type || '').toLowerCase();
    const discount = type === 'percent' || type === '%' || type === 'percentage'
      ? price * value / 100
      : value;
    return roundMoney(Math.min(price, Math.max(0, discount)));
  }

  function getLineData(line) {
    if (line.type === 'product') {
      const product = state.produtos.find(item => item.id === line.id);
      if (!product) return null;
      const price = itemPrice(product);
      const promo = getPromotion(product.id);
      const minQty = Math.max(1, Number(promo && promo.minQty) || 1);
      const unitDiscount = promo && line.qty >= minQty ? promotionUnitDiscount(promo, price) : 0;
      return {
        name: itemName(product),
        price,
        promoDiscount: roundMoney(unitDiscount * line.qty),
        total: roundMoney(Math.max(0, price - unitDiscount) * line.qty),
        type: 'product'
      };
    }
    const service = state.servicos.find(item => item.id === line.id);
    if (!service) return null;
    const price = Number(service.price ?? service.salePrice ?? service.valor) || 0;
    return {
      name: itemName(service),
      price: roundMoney(Math.max(0, price)),
      promoDiscount: 0,
      total: roundMoney(Math.max(0, price) * line.qty),
      type: 'service'
    };
  }

  function getTotals() {
    let subtotal = 0;
    let promoDiscount = 0;
    cart.forEach(line => {
      const data = getLineData(line);
      if (!data) return;
      subtotal += data.price * line.qty;
      promoDiscount += data.promoDiscount;
    });
    subtotal = roundMoney(subtotal);
    promoDiscount = roundMoney(promoDiscount);
    const afterPromotions = roundMoney(Math.max(0, subtotal - promoDiscount));
    const maxManualDiscount = roundMoney(afterPromotions * 0.05);
    const manualDiscount = Math.min(roundMoney(Math.max(0, Number($('#manualDiscount').value) || 0)), maxManualDiscount);
    return {
      subtotal,
      promoDiscount,
      afterPromotions,
      maxManualDiscount,
      manualDiscount,
      total: roundMoney(Math.max(0, afterPromotions - manualDiscount))
    };
  }

  function getCategories() {
    const categories = new Set();
    state.produtos
      .filter(product => product.active !== false && Number(product.qty) > 0)
      .forEach(product => itemCategories(product).forEach(category => categories.add(category)));
    if (state.servicos.some(service => service.active !== false)) categories.add('Serviços');
    return [...categories].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function renderCategoryFilters() {
    const categories = ['Tudo', ...getCategories()];
    if (!categories.includes(activeCategory)) activeCategory = 'Tudo';
    $('#categoryFilters').innerHTML = categories.map(category =>
      `<button class="category-chip${category === activeCategory ? ' active' : ''}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === activeCategory}">${escapeHtml(category)}</button>`
    ).join('');
  }

  function catalogEntries() {
    const products = state.produtos
      .filter(product => product.active !== false)
      .map(product => ({ ...product, id: product.id, type: 'product' }));
    const services = state.servicos
      .filter(service => service.active !== false)
      .map(service => ({ ...service, id: service.id, type: 'service' }));
    return [...products, ...services];
  }

  function renderCatalog() {
    const query = $('#catalogSearch').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = catalogEntries().filter(item => {
      const isService = item.type === 'service';
      const category = isService ? 'Serviços' : itemCategory(item);
      const searchText = `${itemName(item)} ${item.brand || ''} ${item.code || ''} ${category} ${item.description || item.descricao || ''}`
        .toLocaleLowerCase('pt-BR');
      const matchesCategory = activeCategory === 'Tudo' || (isService
        ? activeCategory === 'Serviços'
        : itemCategories(item).includes(activeCategory));
      const matchesQuery = !query || searchText.includes(query);
      return matchesCategory && matchesQuery;
    });
    $('#catalogCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'itens'}`;
    $('#clearSearch').classList.toggle('hidden', !query);
    if (!filtered.length) {
      $('#catalogGrid').innerHTML = '<div class="empty-state">Nenhum item encontrado.<br>Tente outra busca ou categoria.</div>';
      return;
    }

    $('#catalogGrid').innerHTML = filtered.map(item => {
      const inCart = cart.find(line => line.type === item.type && line.id === item.id);
      const qtyInCart = inCart ? inCart.qty : 0;
      const stock = item.type === 'product' ? Math.max(0, Number(item.qty) || 0) : Infinity;
      const soldOut = stock <= qtyInCart;
      const price = item.type === 'product' ? itemPrice(item) : Number(item.price ?? item.salePrice ?? item.valor) || 0;
      const promo = item.type === 'product' ? getPromotion(item.id) : null;
      const minimum = Math.max(1, Number(promo && promo.minQty) || 1);
      const promoLabel = promo
        ? (String(promo.type).toLowerCase() === 'percent' || promo.type === '%'
          ? `${Number(promo.value)}%`
          : currency(promo.value))
        : '';
      const description = item.type === 'product'
        ? [item.brand, item.sector].filter(Boolean).join(' · ')
        : item.description || item.descricao || 'Serviço Lounge';
      return `<article class="product-card${soldOut ? ' out-of-stock' : ''}">
        <div class="product-card-top"><span class="product-symbol" aria-hidden="true">${item.type === 'service' ? '◉' : escapeHtml(itemName(item).slice(0, 1).toUpperCase())}</span><span class="item-kind">${item.type === 'service' ? 'SERVIÇO' : escapeHtml(itemCategory(item).toUpperCase())}</span></div>
        <h2>${escapeHtml(itemName(item))}</h2>
        <p class="product-description">${escapeHtml(description)}</p>
        ${promo ? `<span class="promo-badge">Promoção ${escapeHtml(promoLabel)} · a partir de ${minimum}</span>` : ''}
        <div class="product-card-bottom"><div><strong class="item-price">${currency(price)}</strong><small class="item-stock">${item.type === 'service' ? 'Disponível' : `${Math.max(0, stock - qtyInCart)} disponível(is)`}</small></div>
        <button class="add-button" type="button" data-add-type="${item.type}" data-add-id="${escapeHtml(item.id)}" aria-label="Adicionar ${escapeHtml(itemName(item))}" ${soldOut ? 'disabled' : ''}>＋</button></div>
      </article>`;
    }).join('');
  }

  function renderCart() {
    cart = cart.filter(line => getLineData(line));
    const count = cart.reduce((sum, line) => sum + line.qty, 0);
    const totals = getTotals();
    $('#cartBarItems').textContent = `${count} ${count === 1 ? 'item' : 'itens'}`;
    $('#cartBarTotal').textContent = currency(totals.total);
    $('#openCart').disabled = !count;
    $('#cartSubtotal').textContent = currency(totals.subtotal);
    $('#promoTotal').textContent = `− ${currency(totals.promoDiscount)}`;
    $('#promoRow').classList.toggle('hidden', totals.promoDiscount <= 0);
    $('#cartTotal').textContent = currency(totals.total);
    $('#discountLimit').textContent = `Máximo permitido: ${currency(totals.maxManualDiscount)}`;
    $('#manualDiscount').max = String(totals.maxManualDiscount);
    $('#manualDiscount').disabled = !count;
    $('#discountReason').disabled = totals.manualDiscount <= 0;
    if (totals.manualDiscount <= 0) $('#discountReason').value = '';
    $('#finishSale').disabled = !cloudReady || !count || isSubmitting;
    $('#finishButtonText').textContent = isSubmitting ? 'Enviando pedido...' : 'Finalizar venda';
    $('#cartLines').innerHTML = cart.length ? cart.map(line => {
      const data = getLineData(line);
      return `<article class="cart-line">
        <div><div class="cart-line-title">${escapeHtml(data.name)}</div><div class="cart-line-sub">${data.type === 'product' ? 'Produto' : 'Serviço'} · ${currency(data.price)} cada</div>
        ${data.promoDiscount ? `<div class="discount-hint">Promoção aplicada: −${currency(data.promoDiscount)}</div>` : ''}
        <div class="cart-line-controls">
          <button class="qty-control" type="button" data-change="${data.type}:${escapeHtml(line.id)}:-1" aria-label="Diminuir ${escapeHtml(data.name)}">−</button>
          <span class="qty-value">${line.qty}</span>
          <button class="qty-control" type="button" data-change="${data.type}:${escapeHtml(line.id)}:1" aria-label="Aumentar ${escapeHtml(data.name)}">＋</button>
          <button class="remove-line" type="button" data-remove="${data.type}:${escapeHtml(line.id)}" aria-label="Remover ${escapeHtml(data.name)}">×</button>
        </div></div><strong class="cart-line-total">${currency(data.total)}</strong>
      </article>`;
    }).join('') : '<div class="cart-empty">Seu carrinho está vazio.</div>';
    renderCatalog();
  }

  function addToCart(type, id) {
    const source = type === 'product' ? state.produtos : state.servicos;
    const item = source.find(entry => entry.id === id);
    if (!item) return;
    const existing = cart.find(line => line.type === type && line.id === id);
    if (type === 'product' && (existing ? existing.qty : 0) >= Number(item.qty || 0)) {
      notify('Não há mais unidades disponíveis desse produto.', true);
      return;
    }
    if (existing) existing.qty += 1;
    else cart.push({ type, id, qty: 1 });
    renderCart();
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function changeQuantity(key) {
    const firstSeparator = key.indexOf(':');
    const type = key.slice(0, firstSeparator);
    const idAndDelta = key.slice(firstSeparator + 1);
    const lastSeparator = idAndDelta.lastIndexOf(':');
    const id = idAndDelta.slice(0, lastSeparator);
    const deltaValue = Number(idAndDelta.slice(lastSeparator + 1));
    const line = cart.find(item => item.type === type && item.id === id);
    if (!line) return;
    if (deltaValue > 0 && type === 'product') {
      const product = state.produtos.find(item => item.id === id);
      if (!product || line.qty >= Number(product.qty || 0)) {
        notify('Não há mais unidades disponíveis desse produto.', true);
        return;
      }
    }
    line.qty += deltaValue;
    if (line.qty <= 0) cart = cart.filter(item => item !== line);
    renderCart();
  }

  function openCart() {
    $('#sheetBackdrop').classList.remove('hidden');
    $('#cartSheet').classList.add('open');
    $('#cartSheet').setAttribute('aria-hidden', 'false');
    $('#cartSheet').inert = false;
    document.body.classList.add('sheet-open');
    $('#closeCart').focus();
  }

  function closeCart() {
    $('#cartSheet').classList.remove('open');
    $('#cartSheet').setAttribute('aria-hidden', 'true');
    $('#cartSheet').inert = true;
    $('#sheetBackdrop').classList.add('hidden');
    document.body.classList.remove('sheet-open');
    $('#openCart').focus();
  }

  function getProductBatches(product) {
    const rawBatches = Array.isArray(product.batches) ? product.batches : [];
    const batches = rawBatches
      .filter(batch => Number(batch.qty) > 0)
      .map((batch, index) => ({ ...batch, id: batch.id || `lote-${index + 1}`, qty: Number(batch.qty) }));
    const lotQty = batches.reduce((sum, batch) => sum + batch.qty, 0);
    const productQty = Math.max(0, Number(product.qty) || 0);
    if (!batches.length && productQty > 0) {
      batches.push({
        id: `legado-${product.id}`,
        qty: productQty,
        unitCost: Number(product.cost) || 0,
        expiry: product.expiry || '',
        receivedAt: product.createdAt || ''
      });
    } else if (productQty > lotQty) {
      batches.push({
        id: `legado-${product.id}`,
        qty: productQty - lotQty,
        unitCost: Number(product.cost) || 0,
        expiry: product.expiry || '',
        receivedAt: product.createdAt || ''
      });
    }
    return batches.sort((a, b) => {
      if (!a.expiry && b.expiry) return 1;
      if (a.expiry && !b.expiry) return -1;
      if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
      return String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''));
    });
  }

  function consumeOldestBatches(batches, qty) {
    let remaining = qty;
    const allocations = [];
    const updated = batches.map(batch => ({ ...batch }));
    for (const batch of updated) {
      if (remaining <= 0) break;
      const taken = Math.min(batch.qty, remaining);
      if (taken <= 0) continue;
      batch.qty -= taken;
      remaining -= taken;
      allocations.push({ batchId: batch.id, qty: taken, expiry: batch.expiry || '' });
    }
    if (remaining > 0) throw new Error(`Estoque insuficiente. Faltam ${remaining} unidade(s).`);
    return { batches: updated.filter(batch => batch.qty > 0), allocations };
  }

  function getTransactionProductLine(line, product) {
    const price = itemPrice(product);
    const promo = getPromotion(product.id);
    const minQty = Math.max(1, Number(promo && promo.minQty) || 1);
    const unitDiscount = promo && line.qty >= minQty ? promotionUnitDiscount(promo, price) : 0;
    const promoDiscount = roundMoney(unitDiscount * line.qty);
    return {
      type: 'product',
      id: line.id,
      name: itemName(product),
      qty: line.qty,
      unitPrice: price,
      promoDiscount,
      manualDiscount: 0,
      total: roundMoney(Math.max(0, price - unitDiscount) * line.qty)
    };
  }

  async function finalizeSale() {
    if (!cloudReady) throw new Error('Aguarde a conexão com o banco de dados.');
    if (!cart.length) throw new Error('Adicione produtos ou serviços antes de finalizar.');
    const attendant = $('#attendantSelect').value;
    if (!STAFF_NAMES.includes(attendant)) {
      $('#attendantSelect').focus();
      throw new Error('Selecione o atendente do pedido.');
    }
    const totals = getTotals();
    const reason = $('#discountReason').value.trim();
    if (totals.manualDiscount > totals.maxManualDiscount) {
      $('#manualDiscount').value = String(totals.maxManualDiscount);
      throw new Error('O desconto manual não pode ultrapassar 5% do total.');
    }
    if (totals.manualDiscount > 0 && !reason) {
      $('#discountReason').focus();
      throw new Error('Informe o motivo obrigatório do desconto.');
    }

    const payment = $('#paymentMethod').value;
    if (!['Dinheiro', 'PIX', 'Débito', 'Crédito'].includes(payment)) throw new Error('Selecione uma forma de pagamento válida.');
    const saleLines = cart.map(line => ({ ...line }));
    const productLines = saleLines.filter(line => line.type === 'product');
    const productRefs = productLines.map(line => ({ line, ref: doc(db, 'produtos', line.id) }));
    const saleRef = doc(collection(db, 'vendas'));
    const requestedManualDiscount = totals.manualDiscount;
    isSubmitting = true;
    renderCart();

    try {
      let saleRecord;
      await runTransaction(db, async transaction => {
        const productSnapshots = await Promise.all(productRefs.map(item => transaction.get(item.ref)));
        const productsById = new Map();
        productSnapshots.forEach((snapshot, index) => {
          const requestedLine = productRefs[index].line;
          if (!snapshot.exists()) throw new Error(`O produto "${requestedLine.id}" não está mais disponível.`);
          const product = { ...snapshot.data(), id: requestedLine.id };
          const currentStock = Math.max(0, Number(product.qty) || 0);
          if (currentStock < requestedLine.qty) {
            throw new Error(`Estoque insuficiente para ${itemName(product)}. Disponível: ${currentStock}.`);
          }
          productsById.set(requestedLine.id, product);
        });

        const lines = saleLines.map(line => {
          if (line.type === 'product') return getTransactionProductLine(line, productsById.get(line.id));
          const service = state.servicos.find(item => item.id === line.id);
          if (!service) throw new Error('Um serviço do pedido não está mais disponível. Atualize o catálogo.');
          const price = roundMoney(Math.max(0, Number(service.price ?? service.salePrice ?? service.valor) || 0));
          return {
            type: 'service',
            id: line.id,
            name: itemName(service),
            qty: line.qty,
            unitPrice: price,
            promoDiscount: 0,
            manualDiscount: 0,
            total: roundMoney(price * line.qty)
          };
        });
        const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0));
        const promoDiscount = roundMoney(lines.reduce((sum, line) => sum + line.promoDiscount, 0));
        const afterPromotions = roundMoney(Math.max(0, subtotal - promoDiscount));
        const maxManualDiscount = roundMoney(afterPromotions * 0.05);
        if (requestedManualDiscount > maxManualDiscount) {
          throw new Error('O total do pedido foi atualizado. Revise o desconto manual, limitado a 5%.');
        }
        if (requestedManualDiscount > 0 && !reason) throw new Error('Informe o motivo obrigatório do desconto.');

        let discountRemaining = requestedManualDiscount;
        let allocationBase = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));
        const lastIndex = lines.length - 1;
        lines.forEach((line, index) => {
          const allocated = index === lastIndex
            ? roundMoney(discountRemaining)
            : roundMoney(allocationBase > 0 ? requestedManualDiscount * line.total / allocationBase : 0);
          discountRemaining = roundMoney(discountRemaining - allocated);
          line.manualDiscount = allocated;
          line.total = roundMoney(Math.max(0, line.total - allocated));
        });

        const allocationsByProductId = new Map();
        productRefs.forEach(({ line, ref }) => {
          const product = productsById.get(line.id);
          const batches = getProductBatches(product);
          const result = consumeOldestBatches(batches, line.qty);
          const remainingQty = result.batches.reduce((sum, batch) => sum + batch.qty, 0);
          transaction.update(ref, { batches: result.batches, qty: remainingQty });
          allocationsByProductId.set(line.id, result.allocations);
        });

        const now = new Date();
        const valorBruto = subtotal;
        const valorDesconto = roundMoney(promoDiscount + requestedManualDiscount);
        const valorLiquido = roundMoney(Math.max(0, valorBruto - valorDesconto));
        const hora = now.toLocaleTimeString('pt-BR', { hour12: false });
        saleRecord = {
          atendente: attendant,
          attendant,
          date: now.toISOString(),
          data: localDate(now),
          hora,
          items: lines.map(line => {
            return {
              ...line,
              ...(line.type === 'product' ? { lotAllocations: allocationsByProductId.get(line.id) || [] } : {})
            };
          }),
          formaPagamento: payment,
          payment,
          valorBruto,
          valorDesconto,
          descontoPromocional: promoDiscount,
          descontoManual: requestedManualDiscount,
          motivoDesconto: requestedManualDiscount > 0 ? reason : '',
          valorLiquido,
          total: valorLiquido
        };
        transaction.set(saleRef, saleRecord);
      });

      cart = [];
      $('#manualDiscount').value = '0';
      $('#discountReason').value = '';
      closeCart();
      renderCart();
      $('#successMessage').textContent = `${currency(saleRecord.valorLiquido)} · ${saleRecord.atendente} · ${saleRecord.hora}`;
      $('#successOverlay').classList.remove('hidden');
    } finally {
      isSubmitting = false;
      renderCart();
    }
  }

  function applySnapshot(name, snapshot) {
    state[name] = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    renderCategoryFilters();
    renderCart();
  }

  function subscribeToCollection(name) {
    return onSnapshot(collection(db, name), snapshot => {
      applySnapshot(name, snapshot);
      initializedCollections.add(name);
      if (initializedCollections.size === COLLECTIONS.length) {
        cloudReady = true;
        setConnection('live', 'Catálogo atualizado');
        renderCart();
      }
    }, error => {
      cloudReady = false;
      setConnection('error', 'Falha na conexão');
      reportError(error);
    });
  }

  function connectFirebase() {
    try {
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      setConnection('pending', 'Carregando catálogo...');
      const unsubscribe = COLLECTIONS.map(subscribeToCollection);
      window.addEventListener('beforeunload', () => unsubscribe.forEach(stop => stop()), { once: true });
    } catch (error) {
      setConnection('error', 'Falha na conexão');
      reportError(error);
    }
  }

  function bindEvents() {
    renderAttendants();
    $('#catalogGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-add-type]');
      if (button) addToCart(button.dataset.addType, button.dataset.addId);
    });
    $('#categoryFilters').addEventListener('click', event => {
      const button = event.target.closest('[data-category]');
      if (!button) return;
      activeCategory = button.dataset.category;
      renderCategoryFilters();
      renderCatalog();
    });
    $('#catalogSearch').addEventListener('input', renderCatalog);
    $('#clearSearch').addEventListener('click', () => {
      $('#catalogSearch').value = '';
      $('#catalogSearch').focus();
      renderCatalog();
    });
    $('#cartLines').addEventListener('click', event => {
      const changeButton = event.target.closest('[data-change]');
      if (changeButton) return changeQuantity(changeButton.dataset.change);
      const removeButton = event.target.closest('[data-remove]');
      if (removeButton) {
        const [type, ...idParts] = removeButton.dataset.remove.split(':');
        const id = idParts.join(':');
        cart = cart.filter(line => line.type !== type || line.id !== id);
        renderCart();
      }
    });
    $('#openCart').addEventListener('click', openCart);
    $('#closeCart').addEventListener('click', closeCart);
    $('#sheetBackdrop').addEventListener('click', closeCart);
    $('#manualDiscount').addEventListener('input', () => {
      const input = $('#manualDiscount');
      const totalsWithoutManual = getTotals();
      const entered = Math.max(0, Number(input.value) || 0);
      if (entered > totalsWithoutManual.maxManualDiscount) {
        input.value = String(totalsWithoutManual.maxManualDiscount);
        notify(`Limite de desconto: ${currency(totalsWithoutManual.maxManualDiscount)} (5% do pedido).`, true);
      }
      renderCart();
    });
    $('#discountReason').addEventListener('input', renderCart);
    $('#finishSale').addEventListener('click', async () => {
      try {
        await finalizeSale();
      } catch (error) {
        reportError(error);
      }
    });
    $('#successDone').addEventListener('click', () => {
      $('#successOverlay').classList.add('hidden');
      $('#catalogSearch').focus();
    });
    $('#successOverlay').addEventListener('click', event => {
      if (event.target === $('#successOverlay')) $('#successOverlay').classList.add('hidden');
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (!$('#successOverlay').classList.contains('hidden')) $('#successOverlay').classList.add('hidden');
        else if ($('#cartSheet').classList.contains('open')) closeCart();
      }
    });
  }

  bindEvents();
  renderCategoryFilters();
  renderCart();
  connectFirebase();
})();
