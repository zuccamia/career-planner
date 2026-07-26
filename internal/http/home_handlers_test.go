package http

import (
	"context"
	"testing"
	"time"

	"github.com/ngochoang/career-planner/internal/applications"
	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/engineering_blogs"
)

type fakeApplicationsActivityService struct {
	counts           []applications.DailyCount
	statusCounts     map[string]int
	transitionCounts []applications.StatusTransitionCount
}

func (f fakeApplicationsActivityService) ListDailyAppliedCounts(ctx context.Context, from, to time.Time) ([]applications.DailyCount, error) {
	return filterApplicationDailyCounts(f.counts, from, to), nil
}

func (f fakeApplicationsActivityService) CountByStatus(ctx context.Context, status string) (int, error) {
	if f.statusCounts == nil {
		return 0, nil
	}
	return f.statusCounts[status], nil
}

func (f fakeApplicationsActivityService) ListStatusTransitionCounts(ctx context.Context) ([]applications.StatusTransitionCount, error) {
	return f.transitionCounts, nil
}

type fakeCommunicationsActivityService struct {
	counts []communications.DailyCount
}

func (f fakeCommunicationsActivityService) ListDailyEntryCounts(ctx context.Context, from, to time.Time) ([]communications.DailyCount, error) {
	return filterCommunicationDailyCounts(f.counts, from, to), nil
}

type fakeEngineeringBlogsActivityService struct {
	counts []engineering_blogs.DailyCount
}

func (f fakeEngineeringBlogsActivityService) ListDailyCreatedCounts(ctx context.Context, from, to time.Time) ([]engineering_blogs.DailyCount, error) {
	return filterEngineeringBlogDailyCounts(f.counts, from, to), nil
}

func filterApplicationDailyCounts(items []applications.DailyCount, from, to time.Time) []applications.DailyCount {
	filtered := make([]applications.DailyCount, 0, len(items))
	for _, item := range items {
		if !item.Day.Before(from) && item.Day.Before(to) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func filterCommunicationDailyCounts(items []communications.DailyCount, from, to time.Time) []communications.DailyCount {
	filtered := make([]communications.DailyCount, 0, len(items))
	for _, item := range items {
		if !item.Day.Before(from) && item.Day.Before(to) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func filterEngineeringBlogDailyCounts(items []engineering_blogs.DailyCount, from, to time.Time) []engineering_blogs.DailyCount {
	filtered := make([]engineering_blogs.DailyCount, 0, len(items))
	for _, item := range items {
		if !item.Day.Before(from) && item.Day.Before(to) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func TestBuildDashboardActivitySeriesBuildsRollingTotalsAndHeights(t *testing.T) {
	now := time.Date(2026, 7, 22, 15, 0, 0, 0, time.UTC)
	days, totals := buildDashboardActivitySeries(
		context.Background(),
		fakeApplicationsActivityService{counts: []applications.DailyCount{{Day: time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC), Count: 2}}},
		fakeCommunicationsActivityService{counts: []communications.DailyCount{{Day: time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC), Count: 4}}},
		fakeEngineeringBlogsActivityService{counts: []engineering_blogs.DailyCount{{Day: time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC), Count: 1}}},
		now,
		3,
	)

	if len(days) != 3 {
		t.Fatalf("expected 3 days, got %d", len(days))
	}
	if days[0].Label != "Jul 20" || days[1].Label != "Jul 21" || days[2].Label != "Jul 22" {
		t.Fatalf("unexpected labels: %+v", days)
	}
	if days[0].AppliedCount != 2 || days[1].ThreadEntryCount != 4 || days[2].TechBlogCount != 1 {
		t.Fatalf("unexpected counts: %+v", days)
	}
	if days[1].ThreadEntryHeight != 100 {
		t.Fatalf("expected max thread height to be 100, got %d", days[1].ThreadEntryHeight)
	}
	if days[2].TechBlogHeight == 0 {
		t.Fatalf("expected non-zero tech blog height, got %d", days[2].TechBlogHeight)
	}
	if totals.Applied != 2 || totals.ThreadEntries != 4 || totals.TechBlogs != 1 || totals.Total != 7 {
		t.Fatalf("unexpected totals: %+v", totals)
	}
}

func TestBuildDashboardActivitySeriesReanchorsToLatestHistoricalActivity(t *testing.T) {
	now := time.Date(2026, 7, 22, 15, 0, 0, 0, time.UTC)
	days, totals := buildDashboardActivitySeries(
		context.Background(),
		fakeApplicationsActivityService{counts: []applications.DailyCount{{Day: time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC), Count: 2}}},
		fakeCommunicationsActivityService{counts: []communications.DailyCount{{Day: time.Date(2026, 6, 13, 0, 0, 0, 0, time.UTC), Count: 1}}},
		fakeEngineeringBlogsActivityService{counts: []engineering_blogs.DailyCount{{Day: time.Date(2026, 6, 14, 0, 0, 0, 0, time.UTC), Count: 3}}},
		now,
		3,
	)

	if len(days) != 3 {
		t.Fatalf("expected 3 days, got %d", len(days))
	}
	if days[0].Label != "Jun 12" || days[1].Label != "Jun 13" || days[2].Label != "Jun 14" {
		t.Fatalf("expected chart to re-anchor to historical activity, got %+v", days)
	}
	if !dashboardActivityHasAnyCounts(days) {
		t.Fatalf("expected historical activity to populate the chart, got %+v", days)
	}
	if days[2].TechBlogCount != 3 {
		t.Fatalf("expected latest historical day to include tech blog count, got %+v", days[2])
	}
	if totals.Applied != 2 || totals.ThreadEntries != 1 || totals.TechBlogs != 3 || totals.Total != 6 {
		t.Fatalf("unexpected totals after re-anchoring: %+v", totals)
	}
}

func TestScaledBarHeightHandlesZeroAndMinimumVisibleHeight(t *testing.T) {
	if got := scaledBarHeight(0, 4); got != 0 {
		t.Fatalf("expected zero height for zero count, got %d", got)
	}
	if got := scaledBarHeight(1, 20); got < 8 {
		t.Fatalf("expected minimum visible height, got %d", got)
	}
}

func TestBuildDashboardPipelineGroupsStatusesAndScalesWidths(t *testing.T) {
	stages := buildDashboardPipeline(context.Background(), fakeApplicationsActivityService{statusCounts: map[string]int{
		"wishlist":             9,
		"applied":              6,
		"online_assessment":    3,
		"first_interview":      2,
		"second_interview":     1,
		"additional_interview": 1,
		"offer":                2,
		"rejected":             4,
		"withdrawn":            1,
	}})

	if len(stages) != 6 {
		t.Fatalf("expected 6 stages, got %d", len(stages))
	}
	if stages[0].Label != "Wishlist" || stages[0].Count != 9 || stages[0].Width != 31 {
		t.Fatalf("unexpected wishlist stage: %+v", stages[0])
	}
	if stages[3].Label != "Interviews" || stages[3].Count != 4 {
		t.Fatalf("unexpected interviews stage: %+v", stages[3])
	}
	if stages[5].Label != "Closed" || stages[5].Count != 5 {
		t.Fatalf("unexpected closed stage: %+v", stages[5])
	}
	if stages[3].Width != 28 {
		t.Fatalf("expected interview stage width to clamp to minimum width, got %d", stages[3].Width)
	}
	if stages[0].FillColor == "" {
		t.Fatalf("expected fill color to be populated: %+v", stages[0])
	}
}

func TestBuildDashboardPipelineOmitsZeroCountStages(t *testing.T) {
	stages := buildDashboardPipeline(context.Background(), fakeApplicationsActivityService{statusCounts: map[string]int{
		"wishlist": 4,
		"applied":  2,
	}})

	if len(stages) != 2 {
		t.Fatalf("expected only non-zero stages, got %d", len(stages))
	}
	if stages[0].Label != "Wishlist" || stages[1].Label != "Applied" {
		t.Fatalf("unexpected stages returned: %+v", stages)
	}
}

func TestBuildDashboardPipelineSankeyBuildsHistoricalTransitionLinks(t *testing.T) {
	stages := []dashboardPipelineStage{
		{Label: "Wishlist", Count: 9, FillColor: "#334155"},
		{Label: "Applied", Count: 6, FillColor: "#2563eb"},
		{Label: "Interviews", Count: 1, FillColor: "#f59e0b"},
		{Label: "Closed", Count: 1, FillColor: "#f43f5e"},
	}

	data := buildDashboardPipelineSankey(context.Background(), fakeApplicationsActivityService{transitionCounts: []applications.StatusTransitionCount{
		{FromStatus: "wishlist", ToStatus: "applied", Count: 2},
		{FromStatus: "applied", ToStatus: "first_interview", Count: 1},
		{FromStatus: "first_interview", ToStatus: "rejected", Count: 1},
	}}, stages)

	if len(data.Nodes) != 3 {
		t.Fatalf("expected 3 nodes after removing wishlist, got %d", len(data.Nodes))
	}
	if data.Nodes[0].Name != "Applied" || data.Nodes[1].Name != "1st interview" || data.Nodes[2].Name != "Rejected" {
		t.Fatalf("unexpected nodes: %+v", data.Nodes)
	}
	if data.Nodes[0].Depth != 0 || data.Nodes[1].Depth != 2 || data.Nodes[2].Depth != 6 {
		t.Fatalf("expected depth metadata on downstream nodes, got %+v", data.Nodes)
	}
	if len(data.Links) != 2 {
		t.Fatalf("expected 2 links after removing wishlist transitions, got %d", len(data.Links))
	}
	if data.Links[0].Source != 0 || data.Links[0].Target != 1 || data.Links[0].Value != 1 {
		t.Fatalf("unexpected first link: %+v", data.Links[0])
	}
	if data.Links[1].Source != 1 || data.Links[1].Target != 2 || data.Links[1].Value != 1 {
		t.Fatalf("unexpected second link: %+v", data.Links[1])
	}
}

func TestBuildDashboardPipelineSankeyOmitsSameGroupTransitions(t *testing.T) {
	stages := []dashboardPipelineStage{{Label: "Interviews", Count: 2, FillColor: "#f59e0b"}}
	data := buildDashboardPipelineSankey(context.Background(), fakeApplicationsActivityService{transitionCounts: []applications.StatusTransitionCount{
		{FromStatus: "first_interview", ToStatus: "second_interview", Count: 1},
	}}, stages)
	if len(data.Nodes) != 2 || len(data.Links) != 1 {
		t.Fatalf("expected status-level sankey data for interview progression, got %+v", data)
	}
}

func TestBuildDashboardPipelineSankeyUsesHistoricalStagesEvenWhenCurrentSnapshotOnlyHasDownstreamStage(t *testing.T) {
	stages := []dashboardPipelineStage{{Label: "Interviews", Count: 1, FillColor: "#f59e0b"}}
	data := buildDashboardPipelineSankey(context.Background(), fakeApplicationsActivityService{transitionCounts: []applications.StatusTransitionCount{
		{FromStatus: "wishlist", ToStatus: "applied", Count: 1},
		{FromStatus: "applied", ToStatus: "online_assessment", Count: 1},
		{FromStatus: "online_assessment", ToStatus: "first_interview", Count: 1},
		{FromStatus: "first_interview", ToStatus: "second_interview", Count: 1},
	}}, stages)
	if len(data.Nodes) != 4 {
		t.Fatalf("expected 4 nodes from historical statuses after removing wishlist, got %d: %+v", len(data.Nodes), data.Nodes)
	}
	if data.Nodes[0].Name != "Applied" || data.Nodes[1].Name != "Assessment" || data.Nodes[2].Name != "1st interview" || data.Nodes[3].Name != "2nd interview" {
		t.Fatalf("unexpected node order: %+v", data.Nodes)
	}
	if len(data.Links) != 3 {
		t.Fatalf("expected 3 status links after removing wishlist transitions, got %d: %+v", len(data.Links), data.Links)
	}
}

func TestScaledFunnelWidthHandlesZeroAndMinimumVisibleWidth(t *testing.T) {
	if got := scaledFunnelWidth(0, 5); got != 28 {
		t.Fatalf("expected minimum width for zero count, got %d", got)
	}
	if got := scaledFunnelWidth(1, 20); got < 28 {
		t.Fatalf("expected minimum visible width, got %d", got)
	}
	if got := scaledFunnelWidth(5, 20); got != 28 {
		t.Fatalf("expected minimum visible width for 25%% share, got %d", got)
	}
	if got := scaledFunnelWidth(20, 20); got != 100 {
		t.Fatalf("expected full width for total share, got %d", got)
	}
}
