// Table filters and sorting requested by the viewer UI.
#pragma once

#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

#include "json_support.hpp"

namespace viewer {

// An error in a filter or sort the user entered (reported as "filter-error").
class FilterError : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

// Dataset table view: `filters` (conditions, all must hold), `sort` (one
// {column, direction} or a list in priority order), and `columns` (visible
// columns in order; null keeps them). Condition operators:
//   text_eq, !=, contains          case-insensitive text comparison
//   numeric_eq, >, >=, <, <=       numeric comparison (non-numbers never match)
//   spectrum_peak, neutral_loss    peak within m/z tolerance (Da or ppm) and
//                                  relative intensity
//   row_ids                        rows whose row id is listed (resolved SMARTS filters)
//   smarts                         rejected: the host resolves it to row_ids
// Conditions on unknown columns or with an empty value are ignored.
MSDataset apply_dataset_view(const MSDataset& dataset, const json& filters, const json& sort,
                             const json& columns = nullptr);

// Positions of the rows of a generic table (the similarity result) that pass
// `filters`, in the order given by `sort` ({column, direction}). Here text_eq
// and != are case-sensitive and unknown columns are errors, as in the
// similarity result viewer.
std::vector<int64_t> table_view_rows(
    int64_t n_rows, const std::vector<std::string>& columns,
    const std::function<std::vector<Value>(const std::string&)>& column_values,
    const json& filters, const json& sort);

// Positions sorted by several keys (stable; missing values last).
std::vector<int64_t> sorted_positions(std::vector<int64_t> positions,
                                      const std::vector<std::vector<Value>>& keys,
                                      const std::vector<bool>& ascending);

}  // namespace viewer
