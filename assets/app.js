(function () {
  "use strict";

  const DEPTH_ALL = "All";
  const CONFIG = { responsive: true, displaylogo: false };
  const TEMPLATE = "plotly_white";
  const CHART_BG = "#ffffff";
  const GRID_COLOR = "#e7ecef";
  const NO_DATA_COLOR = "#b7c0c6";

  const FAMILY_LABELS = {
    probe: "Probe water quality",
    lab: "Lab chemistry",
  };

  const state = {
    family: "probe",
    parameter: "TEMP",
    date: "All",
    depth: DEPTH_ALL,
    cast: "All",
    categories: new Set(),
  };

  let data;
  let categoryColors;
  let stationById;
  let resizeTimer;

  function $(id) {
    return document.getElementById(id);
  }

  function waitForAssets() {
    if (window.Plotly && window.MWRA_DASHBOARD_DATA) {
      data = window.MWRA_DASHBOARD_DATA;
      categoryColors = Object.fromEntries(data.categories.map((d) => [d.name, d.color]));
      stationById = Object.fromEntries(data.stations.map((d) => [d.id, d]));
      data.categories.forEach((category) => state.categories.add(category.name));
      init();
      return;
    }
    window.setTimeout(waitForAssets, 50);
  }

  function init() {
    populateControls();
    updateKpis();
    renderDatasetList();
    renderAll();
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resizeCharts, 120);
    });
  }

  function populateControls() {
    const familySelect = $("family-select");
    familySelect.innerHTML = Object.entries(FAMILY_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
    familySelect.value = state.family;
    familySelect.addEventListener("change", () => {
      state.family = familySelect.value;
      state.parameter = data.parameters[state.family][0].code;
      populateParameterSelect();
      syncCastControl();
      renderAll();
    });

    populateParameterSelect();

    const dateSelect = $("date-select");
    const dates = [...new Set(data.coverage.map((row) => row.date).filter(Boolean))].sort();
    dateSelect.innerHTML =
      `<option value="All">All survey dates</option>` +
      dates.map((date) => `<option value="${date}">${formatDate(date)}</option>`).join("");
    dateSelect.value = state.date;
    dateSelect.addEventListener("change", () => {
      state.date = dateSelect.value;
      updateKpis();
      renderAll();
    });

    $("depth-select").addEventListener("change", (event) => {
      state.depth = event.target.value;
      updateKpis();
      renderAll();
    });

    const castSelect = $("cast-select");
    castSelect.value = state.cast;
    castSelect.addEventListener("change", (event) => {
      state.cast = event.target.value;
      updateKpis();
      renderAll();
    });

    const regionFilter = $("region-filter");
    regionFilter.innerHTML = data.categories
      .map(
        (category) => `
          <label>
            <input type="checkbox" value="${escapeHtml(category.name)}" checked />
            <span class="swatch" style="background:${category.color}"></span>
            ${category.name}
          </label>
        `,
      )
      .join("");
    regionFilter.querySelectorAll("input").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          state.categories.add(input.value);
        } else {
          state.categories.delete(input.value);
        }
        updateKpis();
        renderAll();
      });
    });

    syncCastControl();
  }

  function populateParameterSelect() {
    const parameterSelect = $("parameter-select");
    parameterSelect.innerHTML = data.parameters[state.family]
      .map((param) => `<option value="${param.code}">${param.label}</option>`)
      .join("");
    parameterSelect.value = state.parameter;
    parameterSelect.onchange = () => {
      state.parameter = parameterSelect.value;
      renderAll();
    };
  }

  function syncCastControl() {
    const castSelect = $("cast-select");
    castSelect.disabled = state.family !== "probe";
  }

  function updateKpis() {
    $("kpi-dates").textContent = `${formatDate(data.summary.start)} to ${formatDate(data.summary.end)}`;
    $("kpi-stations").textContent = formatInteger(data.summary.stationCount);
    $("kpi-events").textContent = formatInteger(data.summary.eventCount);
    $("kpi-records").textContent = formatInteger(activeRecords().length);
  }

  function renderAll() {
    updateTitles();
    renderMap();
    renderCoverage();
    renderDepthProfile();
    renderTimeSeries();
    renderHeatmap();
    renderNutrientChart();
    renderPlanktonChart("phyto", "phyto-chart");
    renderZooChart();
    updateKpis();
  }

  function updateTitles() {
    const meta = currentParameter();
    $("map-title").textContent = `${meta.label} by station`;
    $("map-scale").textContent = `${meta.code}${meta.unit ? `, ${meta.unit}` : ""}`;
    $("profile-title").textContent = `${meta.label} depth profile`;
    $("timeseries-title").textContent = `${meta.label} event time series`;
    $("heatmap-title").textContent = `${meta.label} time-depth heatmap`;
  }

  function currentParameter() {
    return data.parameters[state.family].find((param) => param.code === state.parameter);
  }

  function activeRecords(options = {}) {
    const family = options.family || state.family;
    const parameter = options.parameter || state.parameter;
    const includeDate = options.includeDate !== false;
    const includeDepth = options.includeDepth !== false;
    const records = data.records[family] || [];
    return records.filter((row) => {
      if (!state.categories.has(row.category)) return false;
      if (includeDate && state.date !== "All" && row.date !== state.date) return false;
      if (includeDepth && state.depth !== DEPTH_ALL && row.depth_band !== state.depth) return false;
      if (family === "probe" && state.cast !== "All" && row.cast !== state.cast) return false;
      return numberOrNull(row[parameter]) !== null;
    });
  }

  function renderMap() {
    const rows = activeRecords();
    const parameter = currentParameter();
    const stationStats = aggregateBy(rows, (row) => row.STAT_ID, (items) => ({
      mean: mean(items.map((row) => row[state.parameter])),
      n: items.length,
    }));
    const values = Object.values(stationStats)
      .map((d) => d.mean)
      .filter((v) => v !== null);
    const cmin = values.length ? Math.min(...values) : 0;
    const cmax = values.length ? Math.max(...values) : 1;
    const valueRange = cmax - cmin || 1;

    const traces = [nearfieldTrace()];
    let scaleShown = false;
    data.categories.forEach((category) => {
      if (!state.categories.has(category.name)) return;
      const stations = data.stations.filter((station) => station.category === category.name);
      const validStations = stations.filter((station) => stationStats[station.id]);
      const missingStations = stations.filter((station) => !stationStats[station.id]);

      if (validStations.length) {
        traces.push({
          type: "scattergeo",
          mode: "markers+text",
          name: category.name,
          lon: validStations.map((station) => station.lon),
          lat: validStations.map((station) => station.lat),
          text: validStations.map((station) => station.id),
          textposition: "top center",
          textfont: { size: 11, color: "#172126" },
          customdata: validStations.map((station) => {
            const stat = stationStats[station.id];
            return [
              station.id,
              station.description,
              station.category,
              station.waterDepthM,
              stat.mean,
              stat.n,
            ];
          }),
          marker: {
            size: validStations.map((station) => {
              const stat = stationStats[station.id];
              return 13 + ((stat.mean - cmin) / valueRange) * 18;
            }),
            color: validStations.map((station) => stationStats[station.id].mean),
            colorscale: "Viridis",
            cmin,
            cmax,
            showscale: !scaleShown,
            colorbar: {
              title: parameter.unit ? parameter.unit : parameter.code,
              thickness: 12,
              len: 0.72,
            },
            line: { width: 2.2, color: category.color },
          },
          hovertemplate:
            "<b>%{customdata[0]}</b><br>%{customdata[1]}<br>" +
            "%{customdata[2]}<br>" +
            `Mean ${parameter.code}: %{customdata[4]:.3f} ${parameter.unit || ""}<br>` +
            "Records: %{customdata[5]}<br>" +
            "Water depth: %{customdata[3]:.1f} m<extra></extra>",
        });
        scaleShown = true;
      }

      if (missingStations.length) {
        traces.push({
          type: "scattergeo",
          mode: "markers+text",
          name: `${category.name} no visible data`,
          showlegend: false,
          lon: missingStations.map((station) => station.lon),
          lat: missingStations.map((station) => station.lat),
          text: missingStations.map((station) => station.id),
          textposition: "top center",
          textfont: { size: 11, color: "#68747b" },
          marker: {
            size: 10,
            color: NO_DATA_COLOR,
            line: { width: 1.5, color: category.color },
          },
          hovertemplate: "<b>%{text}</b><br>No visible records<extra></extra>",
        });
      }
    });

    const outfall = stationById.N21;
    if (outfall && state.categories.has(outfall.category)) {
      traces.push({
        type: "scattergeo",
        mode: "markers+text",
        name: "Outfall site",
        lon: [outfall.lon],
        lat: [outfall.lat],
        text: ["Outfall"],
        textposition: "bottom center",
        marker: {
          size: 18,
          symbol: "diamond-open",
          color: "#172126",
          line: { color: "#172126", width: 2 },
        },
        hovertemplate: "<b>N21 outfall site</b><extra></extra>",
      });
    }

    Plotly.newPlot(
      "station-map",
      traces,
      baseLayout({
        margin: { t: 8, r: 8, b: 8, l: 8 },
        showlegend: true,
        legend: { orientation: "h", x: 0, y: -0.03, font: { size: 11 } },
        geo: {
          projection: { type: "mercator" },
          lonaxis: { range: [-71.05, -70.14] },
          lataxis: { range: [41.76, 42.55] },
          showland: true,
          landcolor: "#eef2ed",
          showocean: true,
          oceancolor: "#dcecf2",
          showlakes: true,
          lakecolor: "#dcecf2",
          coastlinecolor: "#8ca0a9",
          coastlinewidth: 1,
          showcountries: false,
          showsubunits: true,
          subunitcolor: "#d0d9de",
          bgcolor: CHART_BG,
        },
      }),
      CONFIG,
    );
  }

  function nearfieldTrace() {
    const stationOrder = ["N01", "N04", "N07", "N18", "N01"];
    const stations = stationOrder.map((id) => stationById[id]).filter(Boolean);
    return {
      type: "scattergeo",
      mode: "lines",
      name: "Nearfield overlay",
      lon: stations.map((station) => station.lon),
      lat: stations.map((station) => station.lat),
      fill: "toself",
      fillcolor: "rgba(47, 111, 136, 0.10)",
      line: { color: "rgba(47, 111, 136, 0.62)", width: 2, dash: "dot" },
      hoverinfo: "skip",
      showlegend: true,
    };
  }

  function renderCoverage() {
    const x = data.coverage.map((row) => row.event);
    const traces = [
      ["Downcast", "downcastRecords", "#2f6f88"],
      ["Upcast", "upcastRecords", "#6e8b3d"],
      ["Lab", "labRecords", "#c97939"],
      ["Phyto", "phytoRecords", "#8e5ea2"],
      ["Zoo", "zooRecords", "#77818c"],
    ].map(([name, key, color]) => ({
      type: "bar",
      name,
      x,
      y: data.coverage.map((row) => row[key] || 0),
      customdata: data.coverage.map((row) => [row.date, row.stationCount]),
      marker: { color },
      hovertemplate:
        `<b>${name}</b><br>%{x}<br>%{customdata[0]}<br>` +
        "%{y:,} records, %{customdata[1]} stations<extra></extra>",
    }));

    Plotly.newPlot(
      "coverage-chart",
      traces,
      baseLayout({
        barmode: "stack",
        margin: { t: 8, r: 12, b: 48, l: 58 },
        xaxis: { title: "Survey event", type: "category", gridcolor: GRID_COLOR },
        yaxis: { title: "Records", gridcolor: GRID_COLOR },
        legend: { orientation: "h", x: 0, y: 1.16, font: { size: 11 } },
      }),
      CONFIG,
    );
  }

  function renderDatasetList() {
    const labels = {
      downcast: "Downcast probe",
      upcast: "Upcast probe",
      lab: "Lab chemistry",
      phyto: "Phytoplankton",
      zoo: "Zooplankton",
    };
    $("dataset-list").innerHTML = data.summary.datasets
      .map(
        (dataset) => `
          <div class="dataset-item">
            <span>${labels[dataset.name] || dataset.name}</span>
            <strong>${formatInteger(dataset.records)}</strong>
            <em>${dataset.events} events, ${dataset.stations} stations</em>
          </div>
        `,
      )
      .join("");
  }

  function renderDepthProfile() {
    const rows = activeRecords({ includeDepth: false });
    const parameter = currentParameter();
    const traces = [];
    data.categories.forEach((category) => {
      if (!state.categories.has(category.name)) return;
      const categoryRows = rows.filter((row) => row.category === category.name);
      const stats = depthStats(categoryRows, state.parameter, 5);
      if (!stats.length) return;

      const color = category.color;
      traces.push({
        type: "scatter",
        mode: "lines",
        name: `${category.name} IQR`,
        x: stats.map((row) => row.q75).concat(stats.map((row) => row.q25).reverse()),
        y: stats.map((row) => row.depth).concat(stats.map((row) => row.depth).reverse()),
        fill: "toself",
        fillcolor: hexToRgba(color, 0.13),
        line: { color: "rgba(0,0,0,0)" },
        hoverinfo: "skip",
        showlegend: false,
      });
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        name: category.name,
        x: stats.map((row) => row.mean),
        y: stats.map((row) => row.depth),
        marker: { size: 6, color },
        line: { width: 2.4, color },
        customdata: stats.map((row) => [row.n, row.q25, row.q75]),
        hovertemplate:
          `<b>${category.name}</b><br>` +
          `Depth: %{y:.1f} m<br>Mean ${parameter.code}: %{x:.3f} ${parameter.unit || ""}<br>` +
          "IQR: %{customdata[1]:.3f} to %{customdata[2]:.3f}<br>" +
          "Records: %{customdata[0]}<extra></extra>",
      });
    });

    emptyAwarePlot(
      "depth-profile",
      traces,
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 64 },
        xaxis: {
          title: parameter.unit ? `${parameter.label} (${parameter.unit})` : parameter.label,
          gridcolor: GRID_COLOR,
        },
        yaxis: { title: "Depth (m)", autorange: "reversed", gridcolor: GRID_COLOR },
        legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11 } },
      }),
    );
  }

  function renderTimeSeries() {
    const rows = activeRecords();
    const parameter = currentParameter();
    const traces = [];

    data.categories.forEach((category) => {
      if (!state.categories.has(category.name)) return;
      const categoryRows = rows.filter((row) => row.category === category.name);
      const layers =
        state.depth === DEPTH_ALL
          ? ["Surface (0-5m)", "Deep (>20m)"]
          : [state.depth];
      layers.forEach((layer) => {
        const layerRows =
          state.depth === DEPTH_ALL
            ? categoryRows.filter((row) => row.depth_band === layer)
            : categoryRows;
        const grouped = aggregateBy(layerRows, (row) => row.date, (items) => ({
          mean: mean(items.map((row) => row[state.parameter])),
          n: items.length,
        }));
        const points = Object.entries(grouped)
          .map(([date, stat]) => ({ date, ...stat }))
          .filter((row) => row.mean !== null)
          .sort((a, b) => a.date.localeCompare(b.date));
        if (!points.length) return;
        traces.push({
          type: "scatter",
          mode: "lines+markers",
          name: state.depth === DEPTH_ALL ? `${category.name} ${layer}` : category.name,
          x: points.map((row) => row.date),
          y: points.map((row) => row.mean),
          customdata: points.map((row) => [row.n]),
          marker: { size: 7, color: category.color },
          line: {
            width: layer.includes("Deep") ? 1.8 : 2.6,
            color: category.color,
            dash: layer.includes("Deep") ? "dash" : "solid",
          },
          hovertemplate:
            `%{x}<br>${parameter.code}: %{y:.3f} ${parameter.unit || ""}<br>` +
            "Records: %{customdata[0]}<extra></extra>",
        });
      });
    });

    emptyAwarePlot(
      "time-series",
      traces,
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 64 },
        xaxis: { title: "Survey date", type: "date", gridcolor: GRID_COLOR },
        yaxis: {
          title: parameter.unit ? `${parameter.code} (${parameter.unit})` : parameter.code,
          gridcolor: GRID_COLOR,
        },
        legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11 } },
      }),
    );
  }

  function renderHeatmap() {
    const rows = activeRecords({ includeDepth: false });
    const parameter = currentParameter();
    const dates = [...new Set(rows.map((row) => row.date))].sort();
    const maxDepth = Math.max(10, ...rows.map((row) => numberOrNull(row.DEPTH) || 0));
    const bins = [];
    for (let low = 0; low <= Math.ceil(maxDepth / 5) * 5; low += 5) {
      bins.push(low + 2.5);
    }

    const keyed = aggregateBy(
      rows,
      (row) => `${row.date}|${depthBin(row.DEPTH, 5)}`,
      (items) => mean(items.map((row) => row[state.parameter])),
    );
    const z = bins.map((bin) =>
      dates.map((date) => {
        const value = keyed[`${date}|${bin}`];
        return value === undefined ? null : value;
      }),
    );

    const traces = [
      {
        type: "heatmap",
        x: dates,
        y: bins,
        z,
        colorscale: "Viridis",
        colorbar: { title: parameter.unit || parameter.code },
        hovertemplate:
          "%{x}<br>Depth: %{y:.1f} m<br>" +
          `${parameter.code}: %{z:.3f} ${parameter.unit || ""}<extra></extra>`,
      },
    ];

    emptyAwarePlot(
      "time-depth-heatmap",
      dates.length ? traces : [],
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 64 },
        xaxis: { title: "Survey date", type: "date", gridcolor: GRID_COLOR },
        yaxis: { title: "Depth bin (m)", autorange: "reversed", gridcolor: GRID_COLOR },
      }),
    );
  }

  function renderNutrientChart() {
    const labRows = data.records.lab.filter((row) => {
      if (!state.categories.has(row.category)) return false;
      if (state.date !== "All" && row.date !== state.date) return false;
      if (state.depth !== DEPTH_ALL && row.depth_band !== state.depth) return false;
      return numberOrNull(row.TDN) !== null && numberOrNull(row.TDP) !== null;
    });
    const traces = [];
    if (!labRows.length) {
      emptyAwarePlot(
        "nutrient-chart",
        [],
        baseLayout({
          margin: { t: 10, r: 18, b: 54, l: 64 },
          xaxis: { title: "Total dissolved phosphorus, TDP (uM)", gridcolor: GRID_COLOR },
          yaxis: { title: "Total dissolved nitrogen, TDN (uM)", gridcolor: GRID_COLOR },
        }),
      );
      return;
    }
    const maxTdp = Math.max(1, ...labRows.map((row) => numberOrNull(row.TDP) || 0));

    data.categories.forEach((category) => {
      if (!state.categories.has(category.name)) return;
      const rows = labRows.filter((row) => row.category === category.name);
      if (!rows.length) return;
      traces.push({
        type: "scatter",
        mode: "markers",
        name: category.name,
        x: rows.map((row) => row.TDP),
        y: rows.map((row) => row.TDN),
        customdata: rows.map((row) => [row.STAT_ID, row.date, row.DEPTH]),
        marker: {
          color: category.color,
          size: rows.map((row) => 7 + Math.min(14, (numberOrNull(row.DEPTH) || 0) / 5)),
          opacity: 0.72,
          line: { color: "#ffffff", width: 0.7 },
        },
        hovertemplate:
          "<b>%{customdata[0]}</b> %{customdata[1]}<br>" +
          "TDP: %{x:.3f} uM<br>TDN: %{y:.3f} uM<br>" +
          "Depth: %{customdata[2]:.1f} m<extra></extra>",
      });
    });

    traces.push({
      type: "scatter",
      mode: "lines",
      name: "N:P 16 reference",
      x: [0, maxTdp],
      y: [0, maxTdp * 16],
      line: { color: "#172126", width: 1.5, dash: "dot" },
      hoverinfo: "skip",
    });

    emptyAwarePlot(
      "nutrient-chart",
      traces,
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 64 },
        xaxis: { title: "Total dissolved phosphorus, TDP (uM)", gridcolor: GRID_COLOR },
        yaxis: { title: "Total dissolved nitrogen, TDN (uM)", gridcolor: GRID_COLOR },
        legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11 } },
      }),
    );
  }

  function renderPlanktonChart(kind, targetId) {
    const valueColumn = kind === "phyto" ? "CELLS_PER_L" : "IND_PER_M3";
    const rows = planktonFiltered(kind, valueColumn);
    const totals = aggregateBy(rows, (row) => row.GROUP_ID, (items) =>
      sum(items.map((row) => row[valueColumn])),
    );
    const topGroups = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([group]) => group);
    const palette = ["#2f6f88", "#c97939", "#6e8b3d", "#8e5ea2", "#596b75", "#b07b4f"];
    const traces = topGroups.map((group, index) => {
      const grouped = aggregateBy(
        rows.filter((row) => row.GROUP_ID === group),
        (row) => row.month,
        (items) => mean(items.map((row) => row[valueColumn])),
      );
      const points = Object.entries(grouped)
        .map(([month, value]) => ({ month, value }))
        .sort((a, b) => a.month.localeCompare(b.month));
      return {
        type: "scatter",
        mode: "lines+markers",
        name: group,
        x: points.map((row) => `${row.month}-01`),
        y: points.map((row) => row.value),
        line: { color: palette[index % palette.length], width: 2.4 },
        marker: { size: 7, color: palette[index % palette.length] },
        hovertemplate: `<b>${group}</b><br>%{x|%b %Y}<br>%{y:,.2f}<extra></extra>`,
      };
    });

    emptyAwarePlot(
      targetId,
      traces,
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 72 },
        xaxis: { title: "Month", type: "date", gridcolor: GRID_COLOR },
        yaxis: {
          title: kind === "phyto" ? "Mean cells per L" : "Mean individuals per m3",
          rangemode: "tozero",
          gridcolor: GRID_COLOR,
        },
        legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11 } },
      }),
    );
  }

  function renderZooChart() {
    const rows = planktonFiltered("zoo", "IND_PER_M3");
    const grouped = aggregateBy(rows, (row) => row.DESCR, (items) => ({
      mean: mean(items.map((row) => row.IND_PER_M3)),
      group: items[0].GROUP_ID,
      n: items.length,
    }));
    const top = Object.entries(grouped)
      .map(([taxon, stat]) => ({ taxon, ...stat }))
      .filter((row) => row.mean !== null)
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 10)
      .reverse();

    const traces = [
      {
        type: "bar",
        orientation: "h",
        x: top.map((row) => row.mean),
        y: top.map((row) => truncateLabel(row.taxon, 34)),
        customdata: top.map((row) => [row.group, row.n]),
        marker: { color: "#6e8b3d" },
        hovertemplate:
          "%{y}<br>Mean abundance: %{x:,.2f} ind/m3<br>" +
          "Group: %{customdata[0]}<br>Records: %{customdata[1]}<extra></extra>",
      },
    ];

    emptyAwarePlot(
      "zoo-chart",
      top.length ? traces : [],
      baseLayout({
        margin: { t: 10, r: 18, b: 54, l: 164 },
        xaxis: { title: "Mean individuals per m3", gridcolor: GRID_COLOR },
        yaxis: { title: "", automargin: true },
      }),
    );
  }

  function planktonFiltered(kind, valueColumn) {
    return (data.records[kind] || []).filter((row) => {
      if (!state.categories.has(row.category)) return false;
      if (state.date !== "All" && row.date !== state.date) return false;
      if (state.depth !== DEPTH_ALL && row.depth_band !== state.depth) return false;
      return numberOrNull(row[valueColumn]) !== null;
    });
  }

  function depthStats(rows, parameter, step) {
    const grouped = aggregateBy(
      rows.filter((row) => numberOrNull(row.DEPTH) !== null),
      (row) => depthBin(row.DEPTH, step),
      (items) => {
        const values = items.map((row) => numberOrNull(row[parameter])).filter((v) => v !== null);
        return {
          depth: Number(depthBin(items[0].DEPTH, step)),
          mean: mean(values),
          q25: quantile(values, 0.25),
          q75: quantile(values, 0.75),
          n: values.length,
        };
      },
    );
    return Object.values(grouped)
      .filter((row) => row.mean !== null && row.n > 1)
      .sort((a, b) => a.depth - b.depth);
  }

  function emptyAwarePlot(targetId, traces, layout) {
    if (!traces.length) {
      Plotly.newPlot(
        targetId,
        [],
        {
          ...layout,
          annotations: [
            {
              text: "No records match the active filters.",
              x: 0.5,
              y: 0.5,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              font: { size: 15, color: "#5d6970" },
            },
          ],
        },
        CONFIG,
      );
      return;
    }
    Plotly.newPlot(targetId, traces, layout, CONFIG);
  }

  function resizeCharts() {
    [
      "station-map",
      "coverage-chart",
      "depth-profile",
      "time-series",
      "time-depth-heatmap",
      "nutrient-chart",
      "phyto-chart",
      "zoo-chart",
    ].forEach((id) => {
      const element = $(id);
      if (element) Plotly.Plots.resize(element);
    });
  }

  function baseLayout(overrides) {
    return {
      template: TEMPLATE,
      paper_bgcolor: CHART_BG,
      plot_bgcolor: CHART_BG,
      font: { family: "Inter, system-ui, sans-serif", color: "#172126", size: 12 },
      hoverlabel: { bgcolor: "#172126", bordercolor: "#172126", font: { color: "#ffffff" } },
      margin: { t: 10, r: 16, b: 46, l: 58 },
      ...overrides,
    };
  }

  function aggregateBy(rows, keyFn, reduceFn) {
    const buckets = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (key === null || key === undefined || key === "NaN") return;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    const out = {};
    buckets.forEach((items, key) => {
      out[key] = reduceFn(items);
    });
    return out;
  }

  function depthBin(depth, step) {
    const value = numberOrNull(depth);
    if (value === null) return null;
    return Math.floor(value / step) * step + step / 2;
  }

  function mean(values) {
    const clean = values.map(numberOrNull).filter((value) => value !== null);
    if (!clean.length) return null;
    return sum(clean) / clean.length;
  }

  function sum(values) {
    return values.reduce((total, value) => total + (numberOrNull(value) || 0), 0);
  }

  function quantile(values, q) {
    const clean = values.map(numberOrNull).filter((value) => value !== null).sort((a, b) => a - b);
    if (!clean.length) return null;
    const pos = (clean.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (clean[base + 1] !== undefined) {
      return clean[base] + rest * (clean[base + 1] - clean[base]);
    }
    return clean[base];
  }

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatInteger(value) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
  }

  function formatDate(value) {
    if (!value) return "-";
    return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function truncateLabel(value, maxLength) {
    if (!value) return "";
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace("#", "");
    const red = parseInt(clean.slice(0, 2), 16);
    const green = parseInt(clean.slice(2, 4), 16);
    const blue = parseInt(clean.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  waitForAssets();
})();
