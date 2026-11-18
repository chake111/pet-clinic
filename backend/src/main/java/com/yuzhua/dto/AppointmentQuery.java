package com.yuzhua.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;
import org.springframework.format.annotation.DateTimeFormat;

import java.time.LocalDate;

/**
 * 后台订单列表筛选。
 *
 * day 是给医生工作台用的快捷条件（只看某一天），传了就覆盖 start/end；
 * doctorId 只对管理员有效，医生账号一律被服务端改写为自己的 id。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class AppointmentQuery extends PageQuery {

    private Long doctorId;
    private Long userId;
    private Integer status;
    private Integer payStatus;

    @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
    private LocalDate start;

    @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
    private LocalDate end;

    @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
    private LocalDate day;
}
