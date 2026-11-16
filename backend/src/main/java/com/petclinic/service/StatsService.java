package com.petclinic.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.petclinic.entity.Appointment;
import com.petclinic.entity.Doctor;
import com.petclinic.entity.DoctorReview;
import com.petclinic.entity.Pet;
import com.petclinic.entity.SysUser;
import com.petclinic.mapper.AppointmentMapper;
import com.petclinic.mapper.DoctorMapper;
import com.petclinic.mapper.DoctorReviewMapper;
import com.petclinic.mapper.PetMapper;
import com.petclinic.mapper.SysUserMapper;
import com.petclinic.security.LoginUser;
import com.petclinic.security.UserContext;
import com.petclinic.vo.DashboardVo;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

/**
 * 后台看板统计。
 *
 * 管理员看全院，医生登录后台时同一套接口只出他自己的数字：
 * 靠的是把 doctorId 传进每个统计 SQL（mapper 里 null 即不过滤）。
 * 医生视角下"用户数/宠物数"改成"他服务过的人/宠物"，因为全院注册量对医生没有意义。
 */
@Service
@RequiredArgsConstructor
public class StatsService {

    private static final int DEFAULT_DAYS = 14;
    private static final int MAX_DAYS = 90;
    private static final int TOP_DOCTORS = 8;

    private final AppointmentMapper appointmentMapper;
    private final SysUserMapper sysUserMapper;
    private final PetMapper petMapper;
    private final DoctorMapper doctorMapper;
    private final DoctorReviewMapper reviewMapper;

    public DashboardVo dashboard(Integer days) {
        LoginUser u = UserContext.require();
        // 只有医生账号收窄口径；管理员即便误绑了 doctorId 也看全院
        Long doctorId = u.isDoctor() ? UserContext.requireDoctorId() : null;
        int win = days == null ? DEFAULT_DAYS : Math.min(Math.max(days, 1), MAX_DAYS);

        DashboardVo vo = new DashboardVo();
        vo.setDays(win);
        // 今日五格来自同一条条件聚合：原先 4 次 COUNT + 1 次 SUM 各自扫一遍 appointment
        AppointmentMapper.TodayCard today = appointmentMapper.todayCard(doctorId);
        vo.setTodayOrders(today.getOrders());
        vo.setTodayPending(today.getPending());
        vo.setTodayAccepted(today.getAccepted());
        vo.setTodayFinished(today.getFinished());
        vo.setTodayIncome(today.getIncome() == null ? BigDecimal.ZERO : today.getIncome());

        AppointmentMapper.ServedCount served = appointmentMapper.countServed(doctorId);
        if (doctorId == null) {
            vo.setTotalUsers(count(sysUserMapper.selectCount(Wrappers.<SysUser>lambdaQuery())));
            vo.setTotalPets(count(petMapper.selectCount(Wrappers.<Pet>lambdaQuery())));
        } else {
            vo.setTotalUsers(served.getUsers());
            vo.setTotalPets(served.getPets());
        }
        vo.setTotalDoctors(count(doctorMapper.selectCount(Wrappers.<Doctor>lambdaQuery())));
        vo.setOnlineDoctors(count(doctorMapper.selectCount(
                Wrappers.<Doctor>lambdaQuery().eq(Doctor::getOnlineStatus, 1))));

        vo.setReviewPendingReply(count(reviewMapper.selectCount(Wrappers.<DoctorReview>lambdaQuery()
                .eq(doctorId != null, DoctorReview::getDoctorId, doctorId)
                .eq(DoctorReview::getStatus, 1)
                .and(w -> w.isNull(DoctorReview::getReply).or().eq(DoctorReview::getReply, "")))));

        // 挂着号却没付钱的单：定时任务会在超时后自动释放，这里是释放前的存量
        vo.setUnpaidTimeoutRisk(count(appointmentMapper.selectCount(Wrappers.<Appointment>lambdaQuery()
                .eq(doctorId != null, Appointment::getDoctorId, doctorId)
                .eq(Appointment::getStatus, Appointment.ST_PENDING)
                .eq(Appointment::getPayStatus, Appointment.PAY_NONE))));

        vo.setTrend(appointmentMapper.statDaily(win, doctorId));
        vo.setStatusDist(appointmentMapper.statStatus(win, doctorId));
        vo.setDeptDist(appointmentMapper.statDepartment(win, doctorId));
        // 接诊排行天然是横向比较，医生视角下只留自己那一条没有意义，保持全院口径
        vo.setTopDoctors(appointmentMapper.statTopDoctors(win, TOP_DOCTORS));
        return vo;
    }

    /** 今日五格的取数见 {@link AppointmentMapper#todayCard}，本类只负责口径收窄与兜底 */
    private long count(Long n) {
        return n == null ? 0L : n;
    }
}
