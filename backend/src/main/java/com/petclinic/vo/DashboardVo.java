package com.petclinic.vo;

import lombok.Data;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * 后台看板。
 *
 * 图表数据刻意保留 List<Map> 而不是逐张图定义 VO：
 * 这些是 SQL 聚合出来的两列键值行，ECharts 直接吃 name/value，
 * 为它们各写一个类只会多出六个空壳。数字卡片则是固定口径，用显式字段。
 */
@Data
public class DashboardVo {

    /** 统计窗口天数 */
    private int days;

    private long todayOrders;
    private long todayPending;
    private long todayAccepted;
    private long todayFinished;
    private BigDecimal todayIncome = BigDecimal.ZERO;

    private long totalUsers;
    private long totalPets;
    private long totalDoctors;
    private long onlineDoctors;
    private long reviewPendingReply;
    private long unpaidTimeoutRisk;

    /** 趋势：day / cnt / income */
    private List<Map<String, Object>> trend;
    /** 状态分布：status / cnt */
    private List<Map<String, Object>> statusDist;
    /** 科室分布：name / cnt */
    private List<Map<String, Object>> deptDist;
    /** 医生接诊量排行：name / cnt */
    private List<Map<String, Object>> topDoctors;
}
