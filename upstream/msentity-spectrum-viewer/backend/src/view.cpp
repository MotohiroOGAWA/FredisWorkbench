#include "view.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_set>

namespace viewer {

namespace {

double required_number(const json& value, const std::string& message) {
  if (value.is_number()) return value.get<double>();
  if (value.is_string()) {
    if (auto number = parse_number(value.get<std::string>())) return *number;
  }
  throw FilterError(message);
}

bool numeric_match(const std::string& op, double left, double right) {
  if (op == ">") return left > right;
  if (op == ">=") return left >= right;
  if (op == "<") return left < right;
  if (op == "<=") return left <= right;
  return left == right;  // numeric_eq
}

bool is_numeric_operator(const std::string& op) {
  return op == ">" || op == ">=" || op == "<" || op == "<=" || op == "numeric_eq";
}

// Spectra with a peak (or neutral loss) in [lower, upper] whose intensity
// relative to the base peak is at least `intensity`.
std::vector<bool> peak_mask(const MSDataset& view, const json& condition, bool neutral_loss) {
  double center = 0;
  double threshold = 0;
  double tolerance = 0;
  try {
    center = required_number(condition.value("mz", json()), "");
    std::string tolerance_text = json_text(condition.value("tolerance", json("")));
    auto parsed = parse_number(tolerance_text);
    if (!parsed) throw FilterError("");
    tolerance = *parsed;
    threshold = condition.contains("intensity") ? required_number(condition["intensity"], "") : 0.0;
  } catch (const FilterError&) {
    throw FilterError("m/z, tolerance, and intensity must be numeric");
  }
  if (!std::isfinite(center) || !std::isfinite(threshold)) {
    throw FilterError("m/z and intensity must be finite");
  }
  if (threshold < 0.0 || threshold > 1.0) {
    throw FilterError("intensity must be between 0.0 and 1.0");
  }
  if (!std::isfinite(tolerance) || tolerance < 0) {
    throw FilterError("tolerance must be finite and greater than or equal to zero");
  }
  std::string unit = fold_case(json_text(condition.value("tolerance_unit", json("Da"))));
  double delta = unit == "ppm" ? std::abs(center) * tolerance / 1'000'000 : tolerance;
  double lower = center - delta;
  double upper = center + delta;

  std::vector<double> precursor;
  if (neutral_loss) {
    std::string column = json_text(condition.value("precursor_column", json("")));
    if (column.empty()) column = "PrecursorMZ";
    if (!view.has_column(column)) {
      throw FilterError("column not available in current view: " + column);
    }
    for (const auto& value : view.column_values(column)) {
      auto number = numeric_value(value);
      if (!number || !std::isfinite(*number)) {
        throw FilterError("column '" + column + "' must contain finite numeric values");
      }
      precursor.push_back(*number);
    }
  }

  std::vector<bool> mask(static_cast<std::size_t>(view.size()), false);
  for (int64_t position = 0; position < view.size(); ++position) {
    auto spectrum = view.peaks().spectrum(position);
    double maximum = 0.0;
    if (threshold > 0.0) {
      for (int64_t i = 0; i < spectrum.size(); ++i) maximum = std::max(maximum, spectrum.intensity(i));
      if (maximum <= 0.0) continue;
    }
    for (int64_t i = 0; i < spectrum.size(); ++i) {
      double x = neutral_loss ? precursor[static_cast<std::size_t>(position)] - spectrum.mz(i)
                              : spectrum.mz(i);
      if (x < lower || x > upper) continue;
      if (threshold > 0.0 && spectrum.intensity(i) / maximum < threshold) continue;
      mask[static_cast<std::size_t>(position)] = true;
      break;
    }
  }
  return mask;
}

}  // namespace

std::vector<int64_t> sorted_positions(std::vector<int64_t> positions,
                                      const std::vector<std::vector<Value>>& keys,
                                      const std::vector<bool>& ascending) {
  std::stable_sort(positions.begin(), positions.end(), [&](int64_t a, int64_t b) {
    for (std::size_t k = 0; k < keys.size(); ++k) {
      const Value& x = keys[k][static_cast<std::size_t>(a)];
      const Value& y = keys[k][static_cast<std::size_t>(b)];
      bool mx = is_missing(x);
      bool my = is_missing(y);
      if (mx || my) {
        if (mx && my) continue;
        return my;  // missing values last in either direction
      }
      int order = compare_values(x, y);
      if (order != 0) return ascending[k] ? order < 0 : order > 0;
    }
    return false;
  });
  return positions;
}

MSDataset apply_dataset_view(const MSDataset& dataset, const json& filters, const json& sort,
                             const json& columns) {
  MSDataset view = dataset.slice(0, dataset.size());
  const auto& available = dataset.columns();
  auto has = [&](const std::string& column) {
    return std::find(available.begin(), available.end(), column) != available.end();
  };

  for (const auto& condition : filters.is_array() ? filters : json::array()) {
    if (!condition.is_object()) continue;
    std::string op = json_text(condition.value("operator", json("text_eq")));
    std::vector<bool> mask;
    if (op == "spectrum_peak" || op == "neutral_loss") {
      mask = peak_mask(view, condition, op == "neutral_loss");
    } else if (op == "row_ids") {
      std::unordered_set<int64_t> wanted;
      for (const auto& id : condition.value("row_ids", json::array())) {
        if (id.is_number_integer()) wanted.insert(id.get<int64_t>());
      }
      for (int64_t id : view.peaks().index()) mask.push_back(wanted.count(id) > 0);
    } else {
      std::string column = json_text(condition.value("column", json("")));
      json raw = condition.value("value", json(""));
      if (!has(column) || raw.is_null() || json_text(raw).empty()) continue;
      if (op == "smarts") throw FilterError("SMARTS filtering requires optional RDKit support");
      auto values = view.column_values(column);
      if (is_numeric_operator(op)) {
        double right =
            required_number(raw, "Filter value for " + column + " must be numeric");
        for (const auto& value : values) {
          auto left = numeric_value(value);
          mask.push_back(left.has_value() && numeric_match(op, *left, right));
        }
      } else {
        std::string right = fold_case(json_text(raw));
        for (const auto& value : values) {
          std::string left = fold_case(display_text(value));
          if (op == "contains") {
            mask.push_back(left.find(right) != std::string::npos);
          } else if (op == "!=") {
            mask.push_back(left != right);
          } else {
            mask.push_back(left == right);
          }
        }
      }
    }
    view = view.filter(mask);
  }

  json items = sort.is_object() ? json::array({sort}) : sort.is_array() ? sort : json::array();
  std::vector<std::vector<Value>> keys;
  std::vector<bool> ascending;
  std::vector<std::string> used;
  for (const auto& item : items) {
    if (!item.is_object()) continue;
    std::string column = json_text(item.value("column", json("")));
    if (!has(column) || std::find(used.begin(), used.end(), column) != used.end()) continue;
    used.push_back(column);
    keys.push_back(view.column_values(column));
    ascending.push_back(json_text(item.value("direction", json("asc"))) != "desc");
  }
  if (!keys.empty()) {
    std::vector<int64_t> positions(static_cast<std::size_t>(view.size()));
    std::iota(positions.begin(), positions.end(), 0);
    view = view.select(sorted_positions(std::move(positions), keys, ascending));
  }

  if (columns.is_array()) {
    std::vector<std::string> ordered;
    for (const auto& column : columns) {
      std::string name = json_text(column);
      if (has(name) && std::find(ordered.begin(), ordered.end(), name) == ordered.end()) {
        ordered.push_back(name);
      }
    }
    view.set_columns(ordered);
  }
  return view;
}

std::vector<int64_t> table_view_rows(
    int64_t n_rows, const std::vector<std::string>& columns,
    const std::function<std::vector<Value>(const std::string&)>& column_values,
    const json& filters, const json& sort) {
  std::vector<int64_t> rows(static_cast<std::size_t>(n_rows));
  std::iota(rows.begin(), rows.end(), 0);
  auto has = [&](const std::string& column) {
    return std::find(columns.begin(), columns.end(), column) != columns.end();
  };
  for (const auto& condition : filters.is_array() ? filters : json::array()) {
    std::string column = json_text(condition.value("column", json("")));
    if (!has(column)) throw FilterError("Unknown filter column: " + column);
    std::string op = json_text(condition.value("operator", json("")));
    json raw = condition.value("value", json(""));
    auto values = column_values(column);
    std::vector<int64_t> kept;
    if (is_numeric_operator(op)) {
      double right = required_number(raw, "Filter value must be numeric");
      if (!std::isfinite(right)) throw FilterError("Filter value must be finite");
      for (int64_t row : rows) {
        auto left = numeric_value(values[static_cast<std::size_t>(row)]);
        if (left && numeric_match(op, *left, right)) kept.push_back(row);
      }
    } else {
      if (op != "contains" && op != "text_eq" && op != "!=") {
        throw FilterError("Unknown filter operator: " + op);
      }
      std::string right = json_text(raw);
      std::string right_folded = fold_case(right);
      for (int64_t row : rows) {
        std::string left = display_text(values[static_cast<std::size_t>(row)]);
        bool match = op == "contains" ? fold_case(left).find(right_folded) != std::string::npos
                     : op == "text_eq" ? left == right
                                       : left != right;
        if (match) kept.push_back(row);
      }
    }
    rows = std::move(kept);
  }
  if (sort.is_object() && sort.contains("column")) {
    std::string column = json_text(sort["column"]);
    if (!has(column)) throw FilterError("Unknown sort column: " + column);
    rows = sorted_positions(std::move(rows), {column_values(column)},
                            {json_text(sort.value("direction", json("asc"))) != "desc"});
  }
  return rows;
}

}  // namespace viewer
